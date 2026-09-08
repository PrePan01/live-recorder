import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const SEGMENT_MS = 5_000;
const MAX_BYTES = 1024 * 1024 * 1024;

type Entry = { offset: number; length: number; at: number; keyframe: boolean };
type Segment = { path: string; startedAt: number; endedAt: number; bytes: number; entries: Entry[]; stream: ReturnType<typeof createWriteStream> | null; closing: Promise<void> | null };

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

  constructor(private readonly directory: string, private retainSeconds = 300) {}

  async start(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  setRetainSeconds(seconds: number): void { this.retainSeconds = seconds; this.evict(Date.now()); }

  append(chunk: Buffer, at = Date.now()): void {
    if (this.cleared) return;
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
    const offset = segment.bytes;
    segment.bytes += chunk.length;
    segment.endedAt = at;
    segment.entries.push({ offset, length: chunk.length, at, keyframe: isKeyframe(chunk) });
    this.totalBytes += chunk.length;
    if (!segment.stream!.write(chunk)) void once(segment.stream!, 'drain');
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
    await writeFile(output, Buffer.concat(this.init));
    let bytes = this.init.reduce((sum, part) => sum + part.length, 0);
    let loaded: Segment | null = null;
    let data: Buffer | null = null;
    for (const item of all.slice(start)) {
      if (loaded !== item.segment) { loaded = item.segment; data = await readFile(loaded.path); }
      const chunk = data!.subarray(item.entry.offset, item.entry.offset + item.entry.length);
      await appendFile(output, chunk);
      bytes += chunk.length;
    }
    return { bytes, actualSeconds: Math.max(0, Math.round((Date.now() - all[start]!.entry.at) / 1000)) };
  }

  async clear(): Promise<void> {
    this.cleared = true;
    await this.sealCurrent();
    await rm(this.directory, { recursive: true, force: true });
    this.segments = []; this.current = null; this.init = []; this.totalBytes = 0; this.pending = Buffer.alloc(0);
  }

  /**
   * 清空已缓存媒体，但保留当前 FLV 初始化段。直播流中途不会再次发送文件头，
   * 因此“清空后重新开始”不能等同于销毁并新建整个缓存实例。
   */
  async reset(): Promise<void> {
    const oldSegments = this.segments;
    this.segments = [];
    this.current = null;
    this.totalBytes = 0;
    this.pending = Buffer.alloc(0);
    // mediaStarted/headerCaptured/init 保留，新到的媒体标签可立即落入新的分段。
    for (const segment of oldSegments) {
      if (!segment.stream) continue;
      const stream = segment.stream;
      segment.stream = null;
      segment.closing = once(stream, 'finish').then(() => undefined);
      stream.end();
    }
    await Promise.all(oldSegments.map((segment) => segment.closing));
    await Promise.all(oldSegments.map((segment) => rm(segment.path, { force: true })));
  }

  private rotate(at: number): void {
    if (this.current?.stream) {
      const previous = this.current;
      const stream = previous.stream!;
      previous.stream = null;
      previous.closing = once(stream, 'finish').then(() => undefined);
      stream.end();
    }
    const file = path.join(this.directory, `${at}-${this.segments.length}.part`);
    const segment: Segment = { path: file, startedAt: at, endedAt: at, bytes: 0, entries: [], stream: createWriteStream(file), closing: null };
    this.segments.push(segment); this.current = segment;
  }

  private evict(now: number): void {
    while (this.segments.length > 1 && (this.segments[0]!.endedAt < now - this.retainSeconds * 1000 || this.totalBytes > MAX_BYTES)) {
      const old = this.segments.shift()!;
      this.totalBytes -= old.bytes;
      void rm(old.path, { force: true });
    }
  }

  private async sealCurrent(): Promise<void> {
    const current = this.current;
    if (current?.stream) {
      const stream = current.stream; current.stream = null;
      current.closing = once(stream, 'finish').then(() => undefined);
      stream.end();
    }
    await Promise.all(this.segments.map((segment) => segment.closing));
  }
}
