import { constants, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat, copyFile } from "node:fs/promises";
import * as path from "node:path";
import type { DanmakuGap, DanmakuMessage } from "./types.js";

const BLOCK_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
interface Block { start: number; end: number; min: number; max: number; unmappable: boolean }
interface Index { identity: string; offset: number; blocks: Block[]; pending?: Promise<void> }
const indexes = new Map<string, Index>();
const migrations = new Map<string, Promise<void>>();
function parseMessage(line: Buffer): DanmakuMessage | null {
  try {
    const m = JSON.parse(line.toString("utf8")) as DanmakuMessage;
    return m && typeof m.id === "string" && typeof m.text === "string" &&
      (m.tMs === null || (Number.isFinite(m.tMs) && m.tMs >= 0)) ? m : null;
  } catch { return null; }
}
/** Complete lines only; incomplete growing tails are retried on the next read. */
async function* lines(filePath: string, start: number, end: number) {
  const file = await open(filePath, "r");
  try {
    let offset = start, lineStart = start;
    let pending = Buffer.alloc(0), oversized = false;
    while (offset < end) {
      const chunk = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, end - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      const data = chunk.subarray(0, bytesRead);
      let pos = 0;
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, pos)) {
        const part = data.subarray(pos, newline), next = offset + newline + 1;
        const value = oversized || pending.length + part.length > MAX_LINE_BYTES ? null
          : parseMessage(pending.length ? Buffer.concat([pending, part]) : part);
        yield { start: lineStart, end: next, value };
        pending = Buffer.alloc(0); oversized = false; lineStart = next; pos = newline + 1;
      }
      const tail = data.subarray(pos);
      if (pending.length + tail.length > MAX_LINE_BYTES) { pending = Buffer.alloc(0); oversized = true; }
      else if (!oversized) pending = Buffer.concat([pending, tail]);
      offset += bytesRead;
    }
  } finally { await file.close(); }
}
async function indexFor(filePath: string): Promise<Index> {
  const info = await stat(filePath), identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  let index = indexes.get(filePath);
  if (!index || index.identity !== identity || info.size < index.offset) {
    index = { identity, offset: 0, blocks: [] }; indexes.set(filePath, index);
  }
  indexes.delete(filePath); indexes.set(filePath, index);
  while (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
  if (index.pending) await index.pending;
  if (info.size > index.offset) {
    const current = index;
    current.pending = (async () => {
      for await (const line of lines(filePath, current.offset, info.size)) {
        let block = current.blocks.at(-1);
        if (!block || line.start - block.start >= BLOCK_BYTES) {
          block = { start: line.start, end: line.end, min: Infinity, max: -Infinity, unmappable: false };
          current.blocks.push(block);
        }
        block.end = line.end;
        if (line.value?.unmappable) block.unmappable = true;
        else if (line.value?.tMs != null) {
          block.min = Math.min(block.min, line.value.tMs); block.max = Math.max(block.max, line.value.tMs);
        }
        current.offset = line.end;
      }
    })();
    try { await current.pending; } finally { delete current.pending; }
  }
  return index;
}
export interface DanmakuReadOptions { limit?: number; includeUnmappable?: boolean; cursor?: string }
/** Append-only JSONL with bounded buffering and incremental sparse range indexes. */
export class DanmakuStore {
  private writer: WriteStream | null = null;
  private queue: Buffer[] = [];
  private head = 0;
  private queuedBytes = 0;
  private pumping: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private failed: Error | null = null;
  private count = 0;
  private errorListeners = new Set<(error: Error) => void>();
  private constructor(readonly filePath: string) {}
  static sidecarPathFor(recordingFilePath: string): string {
    const ext = path.extname(recordingFilePath);
    return path.join(path.dirname(recordingFilePath), ".danmaku", `${path.basename(recordingFilePath, ext)}.danmaku.jsonl`);
  }
  private static legacyPathFor(recordingFilePath: string): string {
    const ext = path.extname(recordingFilePath);
    return `${ext ? recordingFilePath.slice(0, -ext.length) : recordingFilePath}.danmaku.jsonl`;
  }
  /** 旧文件首次访问时移入隐藏目录；并发读取共用迁移，已有目标绝不覆盖。 */
  private static async migrateLegacy(recordingFilePath: string): Promise<void> {
    const target = this.sidecarPathFor(recordingFilePath);
    const pending = migrations.get(target);
    if (pending) return pending;
    const source = this.legacyPathFor(recordingFilePath);
    const migration = (async () => {
      for (const suffix of ["", ".gaps.json"]) {
        if (!(await stat(source + suffix).catch(() => null))?.isFile()) continue;
        await mkdir(path.dirname(target), { recursive: true });
        try {
          await copyFile(source + suffix, target + suffix, constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            // 同时存在两份弹幕时保留旧文件，也不将旧缺失账配到新数据。
            if (!suffix) return;
            continue;
          }
          throw error;
        }
        await rm(source + suffix);
      }
      indexes.delete(source);
    })();
    migrations.set(target, migration);
    try { await migration; } finally { migrations.delete(target); }
  }
  static async open(recordingFilePath: string): Promise<DanmakuStore> {
    await this.migrateLegacy(recordingFilePath);
    const filePath = this.sidecarPathFor(recordingFilePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    // Separate a crash-truncated tail from new records without rewriting the old file.
    const existing = await open(filePath, "a+");
    try {
      const info = await existing.stat();
      if (info.size) {
        const last = Buffer.alloc(1);
        await existing.read(last, 0, 1, info.size - 1);
        if (last[0] !== 10) await existing.write(Buffer.from("\n"));
      }
    } finally { await existing.close(); }
    const store = new DanmakuStore(filePath);
    store.writer = createWriteStream(filePath, { flags: "a" });
    store.writer.on("error", error => store.fail(error));
    return store;
  }
  static async openExisting(recordingFilePath: string): Promise<DanmakuStore | null> {
    await this.migrateLegacy(recordingFilePath);
    const filePath = this.sidecarPathFor(recordingFilePath);
    return await stat(filePath).then(s => s.isFile() ? new DanmakuStore(filePath) : null, () => null);
  }
  get error(): Error | null { return this.failed; }
  get size(): number { return this.count; }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener); if (this.failed) listener(this.failed);
    return () => this.errorListeners.delete(listener);
  }
  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error; this.queue = []; this.head = 0; this.queuedBytes = 0;
    for (const listener of this.errorListeners) listener(error);
  }
  append(message: DanmakuMessage): boolean {
    if (this.failed || !this.writer || this.closing) return false;
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    if (line.length > MAX_LINE_BYTES || this.queuedBytes + line.length > MAX_QUEUE_BYTES) {
      this.fail(new Error("弹幕写盘积压，保存已暂停")); return false;
    }
    this.count++; this.queue.push(line); this.queuedBytes += line.length; this.startPump(); return true;
  }
  private startPump(): void {
    if (this.pumping) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (!this.failed && this.head < this.queue.length) this.startPump();
    });
  }
  private async pump(): Promise<void> {
    while (this.head < this.queue.length && this.writer && !this.failed) {
      const line = this.queue[this.head++]!; this.queuedBytes -= line.length;
      const ok = this.writer.write(line);
      if (this.head >= 1024) { this.queue = this.queue.slice(this.head); this.head = 0; }
      if (!ok) await this.waitForDrain(this.writer);
    }
    if (this.head === this.queue.length) { this.queue = []; this.head = 0; }
  }
  private waitForDrain(writer: WriteStream): Promise<void> {
    return new Promise(resolve => {
      const settle = () => { writer.off("drain", settle); writer.off("error", settle); writer.off("close", settle); resolve(); };
      writer.once("drain", settle); writer.once("error", settle); writer.once("close", settle);
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const writer = this.writer;
      if (!writer) return;
      const timer = setTimeout(() => { this.fail(new Error("弹幕写盘超时")); writer.destroy(); }, 5000);
      timer.unref?.();
      try {
        while (this.pumping) await this.pumping;
        if (!writer.destroyed) await new Promise<void>(resolve => {
          const settle = () => { writer.off("error", settle); writer.off("close", settle); resolve(); };
          writer.once("error", settle); writer.once("close", settle); writer.end(settle);
        });
      } finally { clearTimeout(timer); this.writer = null; this.errorListeners.clear(); }
    })();
    return this.closing;
  }
  /** Bounded sequential snapshot for bulk consumers, without building a range index. */
  async *readMessages(): AsyncGenerator<DanmakuMessage> {
    const end = (await stat(this.filePath)).size;
    for await (const line of lines(this.filePath, 0, end)) {
      if (line.value) yield line.value;
    }
  }
  async readRange(fromMs: number, toMs: number, opts: DanmakuReadOptions = {}): Promise<{ messages: DanmakuMessage[]; next: string | null }> {
    const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(Math.floor(opts.limit!), 1), 20000) : 5000;
    const cursor = opts.cursor === undefined ? 0 : Number(opts.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid danmaku cursor");
    const index = await indexFor(this.filePath), messages: DanmakuMessage[] = [];
    for (const block of index.blocks) {
      if (block.end <= cursor || (!(block.max >= fromMs && block.min <= toMs) && !(opts.includeUnmappable && block.unmappable))) continue;
      for await (const line of lines(this.filePath, block.start, block.end)) {
        if (line.start < cursor || !line.value) continue;
        const m = line.value;
        if (m.unmappable ? !opts.includeUnmappable : m.tMs === null || m.tMs < fromMs || m.tMs > toMs) continue;
        if (messages.length >= limit) return { messages, next: String(line.start) };
        messages.push(m);
      }
    }
    return { messages, next: null };
  }
  async saveGaps(gaps: DanmakuGap[]): Promise<void> {
    const file = `${this.filePath}.gaps.json`, temp = `${file}.part`;
    const handle = await open(temp, "w");
    try { await handle.writeFile(JSON.stringify(gaps)); } finally { await handle.close(); }
    await rename(temp, file);
  }
  async readGaps(): Promise<DanmakuGap[]> {
    const handle = await open(`${this.filePath}.gaps.json`, "r").catch(() => null);
    if (!handle) return [];
    try {
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      return Array.isArray(value) ? value.filter((g): g is DanmakuGap => g && Number.isFinite(g.fromMs) && Number.isFinite(g.toMs) && g.toMs >= g.fromMs) : [];
    } catch { return []; } finally { await handle.close(); }
  }
  static async move(from: string, to: string): Promise<void> {
    const a = this.sidecarPathFor(from), b = this.sidecarPathFor(to);
    if (a === b) return;
    await this.migrateLegacy(from);
    for (const suffix of ["", ".gaps.json"]) {
      if (!(await stat(a + suffix).catch(() => null))) continue;
      await mkdir(path.dirname(b), { recursive: true });
      try { await rename(a + suffix, b + suffix); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(a + suffix, b + suffix); await rm(a + suffix, { force: true });
      }
    }
    indexes.delete(a); indexes.delete(b);
  }
  static async remove(recordingFilePath: string): Promise<void> {
    const file = this.sidecarPathFor(recordingFilePath);
    await migrations.get(file);
    const files = [file, this.legacyPathFor(recordingFilePath)];
    for (const candidate of files) indexes.delete(candidate);
    await Promise.all(files.flatMap(candidate => ["", ".gaps.json", ".gaps.json.part"].map(suffix => rm(candidate + suffix, { force: true }))));
  }
}
