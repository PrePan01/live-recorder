import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { AppError } from '../types/error.js';
import type { ErrorObject } from '../types/index.js';
import type { RecordingEngine, RecordingEvent, StreamInput } from './engine.js';

/**
 * 真实录制引擎：HTTP 直拉直播流写入文件，按块产出 data 事件供预览转发；
 * 写入侧用 write stream + drain 背压，预览慢消费不阻塞落盘；断流/停止保留已写部分。
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
    let size = 0;
    yield { type: 'file_created', filePath: outputPath };
    const reader = res.body.getReader();
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.stopped) break;
        size += value.length;
        if (!ws.write(value)) await once(ws, 'drain');
        yield { type: 'data', chunk: value };
      }
    } finally {
      if (this.stopped) await reader.cancel().catch(() => undefined);
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