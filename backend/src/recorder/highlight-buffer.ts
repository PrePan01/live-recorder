import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const SEGMENT_MS = 5_000;
/** A preview cache must never turn a slow disk into unbounded process memory. */
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

/** An entry becomes exportable only after its bytes have reached the cache file. */
type Entry = { offset: number; length: number; at: number; keyframe: boolean; written: boolean };
type Segment = {
  path: string; startedAt: number; endedAt: number; bytes: number; entries: Entry[];
  stream: ReturnType<typeof createWriteStream> | null; closing: Promise<void> | null;
  resolveClosing?: () => void;
};
type WriteOperation = { kind: 'write'; segment: Segment; stream: ReturnType<typeof createWriteStream>; chunk: Buffer; entry: Entry } | { kind: 'close'; segment: Segment; stream: ReturnType<typeof createWriteStream> };
type SealedSnapshot = { segments: Segment[]; done: Promise<void> };

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
  /** Reset temporarily drops preview frames so it cannot delete a newly-rotated segment. */
  private resetting = false;
  /** #32：进行中的导出计数——clear/reset 必须等导出读取完 pinned 分段再删除文件，避免 copyRange ENOENT。 */
  private exportsInFlight = 0;
  private exportsIdle: Promise<void> = Promise.resolve();
  private resolveExportsIdle: (() => void) | null = null;

  constructor(private readonly directory: string, private retainSeconds = 300) {}

  async start(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  setRetainSeconds(seconds: number): void { this.retainSeconds = seconds; this.evict(Date.now()); }

  get isAccepting(): boolean { return !this.cleared && !this.resetting && this.disabledReason === null; }
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
    const entry: Entry = { offset, length: chunk.length, at, keyframe: isKeyframe(chunk), written: false };
    segment.entries.push(entry);
    this.totalBytes += chunk.length;
    this.queuedWriteBytes += chunk.length;
    this.writeQueue.push({ kind: 'write', segment, stream: segment.stream!, chunk: Buffer.from(chunk), entry });
    this.startWritePump();
    this.evict(at);
  }

  availableSeconds(): number {
    const entries = this.segments.flatMap((segment) => segment.entries).filter((entry) => entry.written);
    const first = entries[0];
    const last = entries.at(-1);
    // Do not use wall-clock time here. After a disk failure a cache can stop
    // receiving frames, while wall-clock time would misleadingly keep growing.
    return first && last ? Math.max(0, Math.floor((last.at - first.at) / 1000)) : 0;
  }

  async exportTo(output: string, seconds: number): Promise<{ bytes: number; actualSeconds: number }> {
    if (this.cleared) throw new Error('缓存已清空，无法导出');
    // Rotate synchronously before awaiting I/O. New live frames then flow into
    // a new segment, while this export reads an immutable, pinned snapshot.
    const snapshot = this.sealCurrent();
    const pinned = new Set(snapshot.segments);
    for (const segment of pinned) this.pinned.add(segment);
    this.beginExport();
    try {
      await snapshot.done;
      const all = snapshot.segments.flatMap((segment) => segment.entries.filter((entry) => entry.written).map((entry) => ({ segment, entry })));
      const last = all.at(-1);
      if (!last || this.init.length === 0) throw new Error('缓存尚未收到可导出的关键帧');
      const target = last.entry.at - seconds * 1000;
      let start = all.findIndex((v) => v.entry.at >= target);
      if (start < 0) start = 0;
      while (start > 0 && !all[start]!.entry.keyframe) start -= 1;
      while (start < all.length && !all[start]!.entry.keyframe) start += 1;
      if (start >= all.length) throw new Error('缓存尚未收到可导出的关键帧');
      await mkdir(path.dirname(output), { recursive: true });
      const selected = all.slice(start);
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
      }
      return { bytes, actualSeconds: Math.max(0, Math.round((last.entry.at - all[start]!.entry.at) / 1000)) };
    } finally {
      for (const segment of pinned) this.pinned.delete(segment);
      this.endExport();
    }
  }

  /** #32：导出开始时登记，供 clear/reset 等待。 */
  private beginExport(): void {
    this.exportsInFlight += 1;
    if (this.exportsInFlight === 1) {
      this.exportsIdle = new Promise<void>((resolve) => { this.resolveExportsIdle = resolve; });
    }
  }

  private endExport(): void {
    this.exportsInFlight = Math.max(0, this.exportsInFlight - 1);
    if (this.exportsInFlight === 0) {
      this.resolveExportsIdle?.();
      this.resolveExportsIdle = null;
    }
  }

  /** 等待所有进行中的导出读取完毕；无导出时立即返回。 */
  private waitForExports(): Promise<void> {
    return this.exportsInFlight === 0 ? Promise.resolve() : this.exportsIdle;
  }

  async clear(): Promise<void> {
    this.cleared = true;
    await this.sealCurrent().done;
    // #32：等待进行中的导出读完 pinned 分段，避免并发删除正在读取的缓存文件（copyRange ENOENT）。
    await this.waitForExports();
    await rm(this.directory, { recursive: true, force: true });
    this.segments = []; this.current = null; this.init = []; this.totalBytes = 0; this.pending = Buffer.alloc(0);
    this.writeQueue = []; this.queuedWriteBytes = 0;
  }

  /**
   * 清空已缓存媒体，但保留当前 FLV 初始化段。直播流中途不会再次发送文件头，
   * 因此“清空后重新开始”不能等同于销毁并新建整个缓存实例。
   */
  async reset(): Promise<void> {
    this.resetting = true;
    try {
      const snapshot = this.sealCurrent();
      await snapshot.done;
      this.segments = [];
      this.current = null;
      this.totalBytes = 0;
      this.pending = Buffer.alloc(0);
      this.disabledReason = null;
      // mediaStarted/headerCaptured/init 保留，新到的媒体标签可立即落入新的分段。
      // #32：先等进行中的导出读完 pinned 分段，再删除缓存文件，避免 copyRange ENOENT。
      await this.waitForExports();
      await Promise.all(snapshot.segments.map((segment) => rm(segment.path, { force: true })));
    } finally {
      this.resetting = false;
    }
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

  /**
   * Close the active segment and return a stable export boundary. Setting
   * current to null is deliberate: data arriving while the close drains must
   * rotate into a fresh writable segment instead of targeting a closed stream.
   */
  private sealCurrent(): SealedSnapshot {
    const segments = [...this.segments];
    if (this.current?.stream) this.enqueueClose(this.current);
    this.current = null;
    return {
      segments,
      done: Promise.all(segments.map((segment) => segment.closing)).then(() => undefined),
    };
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

  private async drainWrites(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const operation = this.writeQueue.shift()!;
      try {
        if (operation.kind === 'write') {
          if (!operation.stream.write(operation.chunk)) await once(operation.stream, 'drain');
          operation.entry.written = true;
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
