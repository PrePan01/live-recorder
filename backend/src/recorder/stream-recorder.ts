import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { AppError } from '../types/error.js';
import type { ErrorObject } from '../types/index.js';
import type { RecordingEngine, RecordingEvent, StreamInput } from './engine.js';

/**
 * 流式 FLV 标签时间戳归一化：部分 CDN 直播流（如抖音）的媒体标签时间戳是
 * 直播开播以来的绝对 PTS（首帧即可达数千秒）。若直接落盘，播放器按最后一个标签
 * 时间戳计算时长（录 6 分钟显示 1 小时+），且只播得到实际帧。
 *
 * 策略：音频/视频各自独立扣减首条时间戳（音频首帧、视频首帧分别归 0），
 * 使两条流都从 0 开始、容器时长 = 各自真实跨度（录制时长）。首帧≈0 的正常流（bilibili）透传。
 * 时间戳严格按 FLV 规范读写：3 字节大端（byte4 为高位），byte7 为扩展高字节（>0xFFFFFF 时置 0xFFFFFF+高位）。
 * 兼容任意 chunk 边界（标签可能跨块），可流式处理。
 */
class FlvTimestampNormalizer {
  private baseA: number | null = null;
  private baseV: number | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private headerEmitted = false;

  private static readTs(buf: Buffer, off: number): number {
    return (buf[off + 4]! << 16) | (buf[off + 5]! << 8) | buf[off + 6]! | ((buf[off + 7]! & 0xff) << 24);
  }

  private static writeTs(buf: Buffer, off: number, ts: number): void {
    if (ts <= 0xffffff) {
      buf[off + 4] = (ts >> 16) & 0xff;
      buf[off + 5] = (ts >> 8) & 0xff;
      buf[off + 6] = ts & 0xff;
      buf[off + 7] = 0;
    } else {
      buf[off + 4] = 0xff;
      buf[off + 5] = 0xff;
      buf[off + 6] = 0xff;
      buf[off + 7] = (ts >> 24) & 0xff;
    }
  }

  private mediaTag(tagType: number, offset: number): void {
    const rawTs = FlvTimestampNormalizer.readTs(this.buffer, offset);
    const baseRef = tagType === 8 ? this.baseA : this.baseV;
    const key: 'baseA' | 'baseV' = tagType === 8 ? 'baseA' : 'baseV';
    let base = baseRef;
    if (base === null) {
      base = rawTs > 60_000 ? rawTs : 0;
      this[key] = base;
    }
    if (base > 0) FlvTimestampNormalizer.writeTs(this.buffer, offset, rawTs - base);
  }

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    // FLV 头（9）+ PreviousTagSize0（4）= 13 字节，之后才是标签流。
    if (!this.headerEmitted && this.buffer.length >= 13) {
      out.push(this.buffer.subarray(0, 13));
      this.headerEmitted = true;
      this.buffer = this.buffer.subarray(13);
    }
    if (!this.headerEmitted) return out;
    let offset = 0;
    while (offset + 11 <= this.buffer.length) {
      const tagType = this.buffer[offset]!;
      const dataSize = this.buffer.readUIntBE(offset + 1, 3);
      const tagLen = 11 + dataSize + 4; // 标签头 + 数据 + PreviousTagSize
      if (offset + tagLen > this.buffer.length) break;
      if (tagType === 8 || tagType === 9) this.mediaTag(tagType, offset);
      out.push(this.buffer.subarray(offset, offset + tagLen));
      offset += tagLen;
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
    return out;
  }

  /** 收尾：返回未凑成完整标签的尾部字节；已到达的媒体标签头同样按模式归一化。 */
  remaining(): Buffer {
    if (this.buffer.length === 0) return this.buffer;
    let offset = 0;
    while (offset + 11 <= this.buffer.length) {
      const tagType = this.buffer[offset]!;
      const dataSize = this.buffer.readUIntBE(offset + 1, 3);
      if (tagType === 8 || tagType === 9) this.mediaTag(tagType, offset);
      const tagLen = 11 + dataSize + 4;
      if (offset + tagLen > this.buffer.length) break; // 标签数据不完整，停在标签头之后
      offset += tagLen;
    }
    const b = Buffer.from(this.buffer);
    this.buffer = Buffer.alloc(0);
    return b;
  }
}

/**
 * 真实录制引擎：HTTP 直拉直播流写入文件，按块产出 data 事件供预览转发；
 * 写入侧用 write stream + drain 背压，预览慢消费不阻塞落盘；断流/停止保留已写部分。
 * FLV 标签时间戳在写盘/转发前归一化（抖音等 CDN 绝对 PTS → 相对），保证时长与可播正确。
 */
export class StreamRecordingEngine implements RecordingEngine {
  private stopped = false;
  private controller: AbortController | null = null;

  constructor(private fetcher: typeof fetch = fetch) {}

  stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    return Promise.resolve();
  }

  async *start(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent> {
    this.stopped = false;
    try {
      if (input.format === 'hls') {
        yield* this.runHls(input, outputPath);
      } else {
        yield* this.runHttp(input, outputPath);
      }
    } catch (err) {
      if (this.stopped) return;
      yield { type: 'error', error: this.toErrorObject(err) };
    }
  }

  private async *runHttp(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    let res: Response;
    try {
      res = await this.fetcher(input.url, { ...(input.headers ? { headers: input.headers } : {}), signal: this.controller!.signal });
    } catch (err) {
      if (this.stopped) return;
      throw toNetworkError(err);
    }
    if (!res.ok || !res.body) {
      throw new AppError('NETWORK_UNAVAILABLE', `拉流失败 HTTP ${res.status}`, { retryable: true });
    }
    const ws = createWriteStream(outputPath);
    const normalizer = new FlvTimestampNormalizer();
    let size = 0;
    yield { type: 'file_created', filePath: outputPath };
    const reader = res.body.getReader();
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.stopped) break;
        const chunk = Buffer.from(value);
        // 写盘 + 预览都使用时间戳归一化后的完整 FLV 标签：
        // 文件时长正确（#148），且预览流时间戳为相对值，mpegts.js 实时模式（isLive:true）才能正常推进（#150）。
        for (const part of normalizer.push(chunk)) {
          size += part.length;
          if (!ws.write(part)) await once(ws, 'drain');
          yield { type: 'data', chunk: part };
        }
      }
    } finally {
      if (this.stopped) await reader.cancel().catch(() => undefined);
      // 收尾：把尚未凑成完整标签的尾部字节一并写盘并转发（不完整尾部也转发，保持字节一致）。
      const rest = normalizer.remaining();
      if (rest.length > 0) {
        size += rest.length;
        if (!ws.write(rest)) await once(ws, 'drain');
        yield { type: 'data', chunk: rest };
      }
      await new Promise<void>((resolve) => ws.end(() => resolve()));
    }
    if (this.stopped) return;
    yield { type: 'completed', fileSize: size };
  }

  private async *runHls(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    const ws = createWriteStream(outputPath);
    let size = 0;
    const seen = new Set<string>();
    yield { type: 'file_created', filePath: outputPath };
    let ended = false;
    for (let round = 0; round < 256 && !this.stopped; round += 1) {
      const text = await this.fetchText(input.url, input.headers);
      const parsed = parseM3u8(text, input.url);
      ended = parsed.ended;
      let progressed = false;
      for (const seg of parsed.segments) {
        if (this.stopped) return;
        if (seen.has(seg)) continue;
        seen.add(seg);
        for await (const chunk of this.fetchChunks(seg, input.headers)) {
          size += chunk.length;
          if (!ws.write(chunk)) await once(ws, 'drain');
          yield { type: 'data', chunk };
        }
        progressed = true;
      }
      if (this.stopped) return;
      if (ended || !progressed) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise<void>((resolve) => ws.end(() => resolve()));
    if (this.stopped) return;
    yield { type: 'completed', fileSize: size };
  }

  private async fetchText(url: string, headers: Record<string, string> | undefined): Promise<string> {
    const res = await this.fetcher(url, { ...(headers ? { headers } : {}), ...(this.controller ? { signal: this.controller.signal } : {}) });
    if (!res.ok) throw new AppError('NETWORK_UNAVAILABLE', `HLS 播放列表拉取失败 HTTP ${res.status}`, { retryable: true });
    return res.text();
  }

  private async *fetchChunks(url: string, headers: Record<string, string> | undefined): AsyncIterable<Buffer> {
    const res = await this.fetcher(url, { ...(headers ? { headers } : {}), ...(this.controller ? { signal: this.controller.signal } : {}) });
    if (!res.ok || !res.body) throw new AppError('NETWORK_UNAVAILABLE', `HLS 分片拉取失败 HTTP ${res.status}`, { retryable: true });
    for await (const chunk of res.body) {
      if (this.stopped) return;
      yield Buffer.from(chunk);
    }
  }

  private toErrorObject(err: unknown): ErrorObject {
    if (err instanceof AppError) return err.toObject();
    if (err instanceof Error && err.name === 'AbortError') {
      return new AppError('NETWORK_UNAVAILABLE', '拉流中断', { retryable: true }).toObject();
    }
    return new AppError('RECORDING_START_FAILED', `录制异常: ${(err as Error).message ?? String(err)}`, { retryable: true }).toObject();
  }
}

function toNetworkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('NETWORK_UNAVAILABLE', '拉流失败', { retryable: true });
}

function parseM3u8(text: string, baseUrl: string): { segments: string[]; ended: boolean } {
  const segments: string[] = [];
  let ended = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '#EXT-X-ENDLIST') ended = true;
    if (line.startsWith('#') || line === '') continue;
    segments.push(new URL(line, baseUrl).toString());
  }
  return { segments, ended };
}