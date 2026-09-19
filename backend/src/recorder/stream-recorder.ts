import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { AppError } from '../types/error.js';
import type { ErrorObject } from '../types/index.js';
import type { RecordingEngine, RecordingEvent, RecordingResumeOptions, StreamInput } from './engine.js';

/** 续录选项：文件里已有 FLV 头 + 本段时间戳偏移。 */
export interface FlvNormalizerOptions {
  /** 序列头 ts≈0 而媒体为绝对 PTS（抖音）时，以首个媒体标签为基准。 */
  rebaseFromFirstMedia?: boolean;
  /** 续录：文件里已有 FLV 头，不再重复写入。 */
  skipHeader?: boolean;
  /** 续录：本段所有时间戳统一加上的偏移（上一段结尾时间戳），保证拼接处播放连续。 */
  offsetMs?: number;
}

/**
 * 流式 FLV 标签时间戳归一化：部分 CDN 直播流（如抖音）的媒体标签时间戳是
 * 直播开播以来的绝对 PTS（首帧即可达数千秒）。若直接落盘，播放器按最后一个标签
 * 时间戳计算时长（录 6 分钟显示 1 小时+），且只播得到实际帧。
 *
 * 策略：音频/视频各自独立以【首个媒体标签】（排除 AVC/HEVC/AAC 序列头）扣减归零，
 * 使两条流都从 0 开始、容器时长 = 各自真实跨度（录制时长）。首帧≈0 的正常流（bilibili）透传。
 * 序列头 ts≈0 而媒体为绝对 PTS（抖音）时，基准取首个媒体标签，避免时长虚高（PrePan 复验）。
 * 时间戳严格按 FLV 规范读写：3 字节大端（byte4 为高位），byte7 为扩展高字节（>0xFFFFFF 时置 0xFFFFFF+高位）。
 * 兼容任意 chunk 边界（标签可能跨块），可流式处理。
 */
export class FlvTimestampNormalizer {
  private baseA: number | null = null;
  private baseV: number | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private headerEmitted = false;
  /** 本段写出的最大时间戳；上层据此计算下一段续录的时间偏移。 */
  private maxTs = 0;

  constructor(private readonly options: FlvNormalizerOptions = {}) {}

  /** 本段最后一个媒体时间戳（毫秒，含续录偏移）。 */
  get lastTimestampMs(): number { return this.maxTs; }

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

  /** 是否为 AVC/HEVC/AAC 序列头（编码器配置标签）：不计入时间戳 base——抖音等流序列头 ts≈0 而媒体帧为绝对 PTS。 */
  private isSequenceHeader(tagType: number, offset: number): boolean {
    const ds = this.buffer.readUIntBE(offset + 1, 3);
    if (ds < 2) return false;
    const d0 = this.buffer[offset + 11]!;
    const d1 = this.buffer[offset + 12]!;
    if (tagType === 9) {
      const codec = d0 & 0x0f;
      return (codec === 7 || codec === 12) && d1 === 0;
    }
    if (tagType === 8) {
      return (d0 >> 4) === 10 && d1 === 0;
    }
    return false;
  }

  private mediaTag(tagType: number, offset: number): void {
    // 序列头不参与 base 选择：避免把 ts≈0 的编码器配置当基准，导致绝对 PTS 媒体帧未被扣减（时长虚高）。
    if (this.isSequenceHeader(tagType, offset)) return;
    const rawTs = FlvTimestampNormalizer.readTs(this.buffer, offset);
    const key: 'baseA' | 'baseV' = tagType === 8 ? 'baseA' : 'baseV';
    let base = this[key];
    if (base === null) {
      base = this.options.rebaseFromFirstMedia || rawTs > 60_000 ? rawTs : 0;
      this[key] = base;
    }
    const shift = this.options.offsetMs ?? 0;
    const ts = rawTs - base + shift;
    if (base > 0 || shift !== 0) FlvTimestampNormalizer.writeTs(this.buffer, offset, ts);
    if (ts > this.maxTs) this.maxTs = ts;
  }

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    // FLV 头（9）+ PreviousTagSize0（4）= 13 字节，之后才是标签流。
    // 续录时文件里已有文件头，只消费这 13 字节、不再写入，避免文件中途多出一个头。
    if (!this.headerEmitted && this.buffer.length >= 13) {
      if (!this.options.skipHeader) out.push(this.buffer.subarray(0, 13));
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

  /** 收尾：只返回完整 FLV 标签；丢弃不完整的尾部标签，保证落盘文件结构完整（#181：截断尾标签致 ffprobe duration=0 → 误判损坏）。 */
  remaining(): Buffer {
    if (this.buffer.length === 0) return this.buffer;
    let offset = 0;
    let lastComplete = 0;
    while (offset + 11 <= this.buffer.length) {
      const tagType = this.buffer[offset]!;
      const dataSize = this.buffer.readUIntBE(offset + 1, 3);
      const tagLen = 11 + dataSize + 4;
      if (offset + tagLen > this.buffer.length) break; // 尾部不完整标签：不写入文件
      if (tagType === 8 || tagType === 9) this.mediaTag(tagType, offset);
      offset += tagLen;
      lastComplete = offset;
    }
    const b = Buffer.from(this.buffer.subarray(0, lastComplete));
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
  /** 本段写出的最大媒体时间戳；随 error/completed 上报，供上层计算下一段续录偏移。 */
  private lastTimestampMs = 0;

  constructor(private fetcher: typeof fetch = fetch) {}

  stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    return Promise.resolve();
  }

  async *start(input: StreamInput, outputPath?: string | null, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent> {
    this.stopped = false;
    // 本段一个字节都没拿到就中断时，把传入的偏移原样带回，
    // 避免上层把续录偏移重置为 0、导致下一段时间轴跳回开头。
    this.lastTimestampMs = resume?.timestampOffsetMs ?? 0;
    try {
      if (input.format === 'hls') {
        yield* this.runHls(input, outputPath ?? '', resume);
      } else {
        yield* this.runHttp(input, outputPath ?? null, resume);
      }
    } catch (err) {
      if (this.stopped) return;
      yield { type: 'error', error: this.toErrorObject(err), endTimestampMs: this.lastTimestampMs };
    }
  }

  private async *runHttp(input: StreamInput, outputPath: string | null, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    let res: Response;
    try {
      res = await this.fetcher(input.url, { ...(input.headers ? { headers: input.headers } : {}), signal: this.controller!.signal });
    } catch (err) {
      if (this.stopped) return;
      throw toNetworkError(err);
    }
    if (!res.ok || !res.body) {
      throw httpStreamError(res.status, '拉流');
    }
    // 续录：追加写入已有文件；文件里已有 FLV 头时不再重复写入（首段 0 字节时仍需补头）。
    const append = Boolean(resume?.append);
    const existing = append && outputPath ? await stat(outputPath).catch(() => null) : null;
    const ws = outputPath ? createWriteStream(outputPath, { flags: append ? 'a' : 'w' }) : null;
    const normalizer = new FlvTimestampNormalizer({
      skipHeader: Boolean(existing && existing.size > 0),
      offsetMs: resume?.timestampOffsetMs ?? 0,
    });
    let size = existing?.size ?? 0;
    if (outputPath) yield { type: 'file_created', filePath: outputPath };
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
          if (ws) {
            if (!ws.write(part)) await once(ws, 'drain');
          }
          yield { type: 'data', chunk: part };
        }
        this.lastTimestampMs = normalizer.lastTimestampMs;
      }
    } finally {
      if (this.stopped) await reader.cancel().catch(() => undefined);
      // 收尾：把尚未凑成完整标签的尾部字节一并写盘并转发（不完整尾部也转发，保持字节一致）。
      const rest = normalizer.remaining();
      if (rest.length > 0) {
        size += rest.length;
        if (ws) {
          if (!ws.write(rest)) await once(ws, 'drain');
        }
        yield { type: 'data', chunk: rest };
      }
      this.lastTimestampMs = normalizer.lastTimestampMs;
      await new Promise<void>((resolve) => (ws ? ws.end(() => resolve()) : resolve()));
    }
    if (this.stopped) return;
    yield { type: 'completed', fileSize: size, endTimestampMs: this.lastTimestampMs };
  }

  private async *runHls(input: StreamInput, outputPath: string, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    // HLS 分片本身可拼接，续录直接追加字节即可（时间轴由 TS 自身的 PTS 决定，无需重写）。
    const existing = resume?.append ? await stat(outputPath).catch(() => null) : null;
    const ws = createWriteStream(outputPath, { flags: resume?.append ? 'a' : 'w' });
    let size = existing?.size ?? 0;
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
      // #226：轮询间隔自适应分片目标时长（默认 3s），HLS 短分片（如 2s）不再每 3s 才一波数据致周期性卡顿。
      await new Promise((r) => setTimeout(r, hlsPollIntervalMs(parsed.targetDuration)));
    }
    await new Promise<void>((resolve) => ws.end(() => resolve()));
    if (this.stopped) return;
    yield { type: 'completed', fileSize: size, endTimestampMs: this.lastTimestampMs };
  }

  private async fetchText(url: string, headers: Record<string, string> | undefined): Promise<string> {
    const res = await this.fetcher(url, { ...(headers ? { headers } : {}), ...(this.controller ? { signal: this.controller.signal } : {}) });
    if (!res.ok) throw httpStreamError(res.status, 'HLS 播放列表拉取');
    return res.text();
  }

  private async *fetchChunks(url: string, headers: Record<string, string> | undefined): AsyncIterable<Buffer> {
    const res = await this.fetcher(url, { ...(headers ? { headers } : {}), ...(this.controller ? { signal: this.controller.signal } : {}) });
    if (!res.ok || !res.body) throw httpStreamError(res.status, 'HLS 分片拉取');
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
    // 写盘类错误（磁盘满/权限/IO）与网络无关，标为非可重试，让上层直接收尾而不是空等退避。
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (typeof errno === 'string' && WRITE_ERRNO.has(errno)) {
      return new AppError('RECORDING_WRITE_FAILED', `写入录像文件失败（${errno}）`, { retryable: false, details: { errno } }).toObject();
    }
    return new AppError('RECORDING_START_FAILED', `录制异常: ${(err as Error).message ?? String(err)}`, { retryable: true }).toObject();
  }
}

/** 写盘失败的系统错误码：命中即说明是磁盘问题，重试拉流不会好。 */
const WRITE_ERRNO = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EBUSY']);

function toNetworkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('NETWORK_UNAVAILABLE', '拉流失败', { retryable: true });
}

/**
 * 按 HTTP 状态归类拉流失败：地址过期与平台服务异常各自可辨，
 * 而不是一律归成"网络不可用"，否则失败原因对不上用户实际遇到的情况。
 */
function httpStreamError(status: number, what: string): AppError {
  if (status === 401 || status === 403 || status === 410) {
    return new AppError('STREAM_URL_EXPIRED', `${what}失败 HTTP ${status}`, { retryable: true });
  }
  if (status >= 500) {
    return new AppError('PLATFORM_SERVER_ERROR', `${what}失败 HTTP ${status}`, { retryable: true });
  }
  return new AppError('NETWORK_UNAVAILABLE', `${what}失败 HTTP ${status}`, { retryable: true });
}

export function parseM3u8(text: string, baseUrl: string): { segments: string[]; ended: boolean; targetDuration: number | null } {
  const segments: string[] = [];
  let ended = false;
  let targetDuration: number | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '#EXT-X-ENDLIST') ended = true;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const d = Number(line.split(':')[1]);
      if (Number.isFinite(d) && d > 0) targetDuration = d;
    }
    if (line.startsWith('#') || line === '') continue;
    segments.push(new URL(line, baseUrl).toString());
  }
  return { segments, ended, targetDuration };
}

/** #226：HLS 轮询间隔 = min(目标分片时长 × 0.8, 3000ms) 且 ≥1000ms；未知时长回退 3000ms。 */
export function hlsPollIntervalMs(targetDuration: number | null): number {
  if (!targetDuration) return 3000;
  return Math.min(Math.max(Math.round(targetDuration * 800), 1000), 3000);
}
