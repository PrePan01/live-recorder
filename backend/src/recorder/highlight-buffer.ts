import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const SEGMENT_MS = 5_000;
/** A preview cache must never turn a slow disk into unbounded process memory. */
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

type Entry = { offset: number; length: number; at: number; keyframe: boolean };
type Segment = {
  path: string; startedAt: number; endedAt: number; bytes: number; entries: Entry[];
  stream: ReturnType<typeof createWriteStream> | null; closing: Promise<void> | null;
  resolveClosing?: () => void;
};
type WriteOperation = { kind: 'write'; segment: Segment; stream: ReturnType<typeof createWriteStream>; chunk: Buffer } | { kind: 'close'; segment: Segment; stream: ReturnType<typeof createWriteStream> };

function isMedia(chunk: Buffer): boolean {
  if (chunk.length < 13 || (chunk[0] !== 8 && chunk[0] !== 9)) return false;
  const size = chunk.readUIntBE(1, 3);
  if (size + 15 !== chunk.length) return false;
  const codec = chunk[11]! & 0x0f;
  const seq = (chunk[0] === 9 && (codec === 7 || codec === 12) && chunk[12] === 0) || (chunk[0] === 8 && (chunk[11]! >> 4) === 10 && chunk[12] === 0);
  return !seq;
}

function isKeyframe(chunk: Buffer): boolean { return chunk.length >= 12 && chunk[0] === 9 && (chunk[11]! & 0xf0) === 0x10; }

/** Disk-backed rolling FLV cache used only by the explicit normal-preview highlight feature. */
export class HighlightBuffer {
  private init: Buffer[] = [];
  private mediaStarted = false;
  private segments: Segment[] = [];
  private current: Segment | null = null;
  private totalBytes = 0;
  private cleared = false;
  private pending = Buffer.alloc(0);
  private headerCaptured = false;
  /** Segments pinned by an export cannot be removed by concurrent cache eviction. */
  private pinned = new Set<Segment>();
  /** A single writer prevents duplicate drain listeners and preserves FLV tag order. */
  private writeQueue: WriteOperation[] = [];
  private queuedWriteBytes = 0;
  private writePump: Promise<void> | null = null;
  private disabledReason: 'slow_disk' | 'write_error' | null = null;

  constructor(private readonly directory: string, private retainSeconds = 300) {}

  async start(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  setRetainSeconds(seconds: number): void { this.retainSeconds = seconds; this.evict(Date.now()); }

  get isAccepting(): boolean { return !this.cleared && this.disabledReason === null; }
  get backpressureReason(): 'slow_disk' | 'write_error' | null { return this.disabledReason; }

  append(chunk: Buffer, at = Date.now()): void {
    if (!this.isAccepting) return;
    // 引擎通常逐标签回调，但不能依赖该实现细节：fake/HLS/网络合包都可能一次给出多个标签。
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    if (!this.headerCaptured) {
      if (this.pending.length < 13) return;
      if (this.pending.subarray(0, 3).toString() !== 'FLV') { this.pending = Buffer.alloc(0); return; }
      this.init.push(this.pending.subarray(0, 13));
      this.pending = this.pending.subarray(13);
      this.headerCaptured = true;
    }
    while (this.pending.length >= 11) {
      const length = 11 + this.pending.readUIntBE(1, 3) + 4;
      if (this.pending.length < length) return;
      const tag = this.pending.subarray(0, length);
      this.pending = this.pending.subarray(length);
      if (!this.mediaStarted && !isMedia(tag)) { this.init.push(Buffer.from(tag)); continue; }
      if (!isMedia(tag)) continue;
      this.mediaStarted = true;
      this.appendMedia(tag, at);
    }
  }

  private appendMedia(chunk: Buffer, at: number): void {
    if (!this.current || at - this.current.startedAt >= SEGMENT_MS) this.rotate(at);
    const segment = this.current!;
    if (this.queuedWriteBytes + chunk.length > MAX_PENDING_WRITE_BYTES) {
      // Keep completed files intact: a user can still export the portion that
      // reached disk, but do not let a stalled volume consume more memory.
      this.disabledReason = 'slow_disk';
      return;
    }
    const offset = segment.bytes;
    segment.bytes += chunk.length;
    segment.endedAt = at;
    segment.entries.push({ offset, length: chunk.length, at, keyframe: isKeyframe(chunk) });
    this.totalBytes += chunk.length;
    this.queuedWriteBytes += chunk.length;
    this.writeQueue.push({ kind: 'write', segment, stream: segment.stream!, chunk: Buffer.from(chunk) });
    this.startWritePump();
    this.evict(at);
  }

  availableSeconds(now = Date.now()): number {
    const first = this.segments.flatMap((s) => s.entries).at(0);
    return first ? Math.max(0, Math.floor((now - first.at) / 1000)) : 0;
  }

  async exportTo(output: string, seconds: number): Promise<{ bytes: number; actualSeconds: number }> {
    await this.sealCurrent();
    const all = this.segments.flatMap((segment) => segment.entries.map((entry) => ({ segment, entry })));
    const target = Date.now() - seconds * 1000;
    let start = all.findIndex((v) => v.entry.at >= target);
    if (start < 0) start = 0;
    while (start > 0 && !all[start]!.entry.keyframe) start -= 1;
    while (start < all.length && !all[start]!.entry.keyframe) start += 1;
    if (start >= all.length || this.init.length === 0) throw new Error('缓存尚未收到可导出的关键帧');
    await mkdir(path.dirname(output), { recursive: true });
    const selected = all.slice(start);
    const pinned = new Set(selected.map((item) => item.segment));
    for (const segment of pinned) this.pinned.add(segment);
    let bytes = this.init.reduce((sum, part) => sum + part.length, 0);
    const stream = createWriteStream(output);
    try {
      for (const part of this.init) await writeChunk(stream, part);
      // Entries in one segment are appended sequentially. Coalesce contiguous
      // tag offsets so a large export issues range reads, not one read per tag.
      for (const [segment, entries] of groupEntries(selected)) {
        let rangeStart = entries[0]!.offset;
        let rangeEnd = rangeStart + entries[0]!.length - 1;
        for (const entry of entries.slice(1)) {
          if (entry.offset === rangeEnd + 1) {
            rangeEnd += entry.length;
            continue;
          }
          await copyRange(segment.path, rangeStart, rangeEnd, stream);
          bytes += rangeEnd - rangeStart + 1;
          rangeStart = entry.offset;
          rangeEnd = rangeStart + entry.length - 1;
        }
        await copyRange(segment.path, rangeStart, rangeEnd, stream);
        bytes += rangeEnd - rangeStart + 1;
      }
      stream.end();
      await once(stream, 'finish');
    } catch (error) {
      stream.destroy();
      throw error;
    } finally {
      for (const segment of pinned) this.pinned.delete(segment);
    }
    return { bytes, actualSeconds: Math.max(0, Math.round((Date.now() - all[start]!.entry.at) / 1000)) };
  }

  async clear(): Promise<void> {
    this.cleared = true;
    await this.sealCurrent();
    await rm(this.directory, { recursive: true, force: true });
    this.segments = []; this.current = null; this.init = []; this.totalBytes = 0; this.pending = Buffer.alloc(0);
    this.writeQueue = []; this.queuedWriteBytes = 0;
  }

  /**
   * 清空已缓存媒体，但保留当前 FLV 初始化段。直播流中途不会再次发送文件头，
   * 因此“清空后重新开始”不能等同于销毁并新建整个缓存实例。
   */
  async reset(): Promise<void> {
    await this.sealCurrent();
    const oldSegments = this.segments;
    this.segments = [];
    this.current = null;
    this.totalBytes = 0;
    this.pending = Buffer.alloc(0);
    this.disabledReason = null;
    // mediaStarted/headerCaptured/init 保留，新到的媒体标签可立即落入新的分段。
    await Promise.all(oldSegments.map((segment) => segment.closing));
    await Promise.all(oldSegments.map((segment) => rm(segment.path, { force: true })));
  }

  private rotate(at: number): void {
    if (this.current?.stream) this.enqueueClose(this.current);
    const file = path.join(this.directory, `${at}-${this.segments.length}.part`);
    const stream = createWriteStream(file);
    // The pump observes write errors too; this listener prevents an async
    // filesystem failure from becoming an unhandled EventEmitter error.
    stream.on('error', () => { this.disabledReason ??= 'write_error'; });
    const segment: Segment = { path: file, startedAt: at, endedAt: at, bytes: 0, entries: [], stream, closing: null };
    this.segments.push(segment); this.current = segment;
  }

  private evict(now: number): void {
    while (this.segments.length > 1 && !this.pinned.has(this.segments[0]!) && this.segments[0]!.endedAt < now - this.retainSeconds * 1000) {
      const old = this.segments.shift()!;
      this.totalBytes -= old.bytes;
      void rm(old.path, { force: true });
    }
  }

  private async sealCurrent(): Promise<void> {
    if (this.current?.stream) this.enqueueClose(this.current);
    await this.waitForWrites();
    await Promise.all(this.segments.map((segment) => segment.closing));
  }

  private enqueueClose(segment: Segment): void {
    if (!segment.stream) return;
    const stream = segment.stream;
    segment.stream = null;
    segment.closing = new Promise<void>((resolve) => { segment.resolveClosing = resolve; });
    this.writeQueue.push({ kind: 'close', segment, stream });
    this.startWritePump();
  }

  private startWritePump(): void {
    if (this.writePump) return;
    this.writePump = this.drainWrites().finally(() => {
      this.writePump = null;
      if (this.writeQueue.length > 0) this.startWritePump();
    });
  }

  private async waitForWrites(): Promise<void> {
    while (this.writePump) await this.writePump;
  }

  private async drainWrites(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const operation = this.writeQueue.shift()!;
      try {
        if (operation.kind === 'write') {
          if (!operation.stream.write(operation.chunk)) await once(operation.stream, 'drain');
          this.queuedWriteBytes -= operation.chunk.length;
        } else {
          operation.stream.end();
          await once(operation.stream, 'finish');
          operation.segment.resolveClosing?.();
        }
      } catch {
        this.disabledReason ??= 'write_error';
        if (operation.kind === 'write') this.queuedWriteBytes -= operation.chunk.length;
        operation.segment.resolveClosing?.();
      }
    }
  }
}

function groupEntries(items: Array<{ segment: Segment; entry: Entry }>): Map<Segment, Entry[]> {
  const grouped = new Map<Segment, Entry[]>();
  for (const item of items) (grouped.get(item.segment) ?? (grouped.set(item.segment, []), grouped.get(item.segment)!)).push(item.entry);
  return grouped;
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function copyRange(file: string, start: number, end: number, output: ReturnType<typeof createWriteStream>): Promise<void> {
  const input = createReadStream(file, { start, end });
  for await (const chunk of input) await writeChunk(output, chunk as Buffer);
}
