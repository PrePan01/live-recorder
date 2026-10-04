import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 跳播定位索引（关键帧 → 文件字节偏移）。
 *
 * 为什么需要：FLV 无索引，ffmpeg 按比例估算位置后要回扫找关键帧，GB 级录像在慢盘上
 * 动辄几十秒（实测 5.4GB 后段 seek 约 106s）。录制期顺手记下「关键帧在第几个字节」，
 * 跳播时把字节偏移直接喂给 ffmpeg，定位成本与文件大小无关（实测首包 <200ms）。
 *
 * 存储：视频旁的 `<视频名>.seekindex.jsonl` 侧车文件，只追加不回头重写（不伤写盘）。
 * 首行 `{"v":1}`，随后每行一个条目：关键帧 `{"t":毫秒,"b":字节偏移}`、
 * 编码器序列头 `{"t":毫秒,"b":偏移,"s":1,"k":8|9}`。崩溃截断的尾行读取时裁掉。
 */

export interface SeekEntry {
  /** 媒体时间戳（毫秒，与文件内写入值一致）。 */
  t: number;
  /** 文件内字节偏移（标签起始处）。 */
  b: number;
  /** 1=编码器序列头标签（解码初始化需要，起流时拼在数据前）。 */
  s?: 1;
  /** 序列头所属流类型：9=视频 8=音频。 */
  k?: 8 | 9;
}

export function seekSidecarPath(filePath: string): string {
  // 归位：索引不与视频混放，统一进房间目录下的 .cache（中文房名/双平台均由 path 层处理）。
  return path.join(path.dirname(filePath), '.cache', `${path.basename(filePath)}.seekindex.jsonl`);
}

function isKeyframeVideoTag(tagType: number, data0: number, data1: number): boolean {
  if (tagType !== 9) return false;
  if ((data0 & 0x0f) !== 7 && (data0 & 0x0f) !== 12) return false;
  return (data0 >> 4) === 1 && data1 !== 0;
}

function isVideoSeqHeader(data0: number, data1: number): boolean {
  return ((data0 & 0x0f) === 7 || (data0 & 0x0f) === 12) && data1 === 0;
}

function isAudioSeqHeader(data0: number, data1: number): boolean {
  return data0 >> 4 === 10 && data1 === 0;
}

/**
 * 索引写入器：录制写盘链逐标签顺手记，append 一条几十字节。
 * 写失败只降级索引（跳播不可用），绝不影响录制本身。
 */
export class SeekIndexWriter {
  private pending: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private broken = false;

  private constructor(
    private handle: Awaited<ReturnType<typeof open>>,
    readonly filePath: string,
    readonly baseBytes: number,
  ) {}

  static async open(
    filePath: string,
    baseBytes: number,
    opts: { trackCoverage?: boolean } = {},
  ): Promise<SeekIndexWriter | null> {
    try {
      const target = seekSidecarPath(filePath);
      await mkdir(path.dirname(target), { recursive: true });
      const existing = await stat(target).catch(() => null);
      const handle = await open(target, 'a');
      const writer = new SeekIndexWriter(handle, filePath, baseBytes);
      if (!existing || existing.size === 0) writer.noteRaw('{"v":1}');
      if (opts.trackCoverage !== false) noteSeekCoverage(filePath, baseBytes);
      return writer;
    } catch (error) {
      // 打开阶段失败（EISDIR 类路径占位/权限）不留痕曾是观测盲区：降级但可见。
      console.log('[seek] writer-open-failed', filePath, (error as Error)?.message ?? error);
      return null;
    }
  }

  private noteRaw(line: string): void {
    this.pending.push(line);
    if (this.pending.length > 2000) {
      // 无界缓存禁止：积压过多说明磁盘写不动，丢弃并降级，绝不反压录制。
      this.broken = true;
      this.pending.length = 0;
      console.log('[seek] writer-degraded（积压超限丢弃）', this.filePath);
      return;
    }
    this.chain = this.chain.then(async () => {
      if (this.closed || this.broken) return;
      const lines = this.pending.splice(0, this.pending.length).join('\n') + '\n';
      if (lines === '\n') return; // 同批已被上一拍冲走，避免写空行
      await this.writeWithReopen(lines);
    }).catch(() => {
      // writeWithReopen 内部已重试过；到这里是彻底写不动（磁盘/卷故障），降级待重建。
      this.broken = true;
      this.pending.length = 0;
      console.log('[seek] writer-degraded（写入失败，待补扫重建）', this.filePath);
    });
  }

  /** 写失败自愈：重开句柄重试一次——USB 抖一下不应永久杀死索引（实测曾冻结在 30s 处）。 */
  private async writeWithReopen(lines: string): Promise<void> {
    try {
      await this.handle.write(lines);
      return;
    } catch {
      // 落到重开重试
    }
    await this.handle.close().catch(() => undefined);
    this.handle = await open(seekSidecarPath(this.filePath), 'a');
    await this.handle.write(lines);
  }

  /** 记一个条目（关键帧或序列头）。 */
  note(entry: SeekEntry): void {
    if (this.closed || this.broken) return;
    const parts = [`"t":${entry.t | 0}`, `"b":${entry.b}`];
    if (entry.s !== undefined) parts.push('"s":1', `"k":${entry.k ?? 9}`);
    this.noteRaw(`{${parts.join(',')}}`);
    markSeekIndexed(this.filePath, entry.b);
  }

  /** 写入器是否已降级（诊断用）。 */
  get degraded(): boolean {
    return this.broken;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.chain.catch(() => undefined);
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

/** 读侧车：解析 JSONL，裁掉损坏尾行，按时间排序、按偏移去重。 */
export async function loadSeekIndex(filePath: string): Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> {
  const target = seekSidecarPath(filePath);
  const entries: SeekEntry[] = [];
  const seqs: SeekEntry[] = [];
  let raw: string;
  try {
    const handle = await open(target, 'r');
    try {
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return { entries, seqs };
  }
  const seen = new Set<number>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '{"v":1}') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // 崩溃截断/写坏的行：裁掉，宁缺勿错
    }
    const t = Number(obj.t);
    const b = Number(obj.b);
    if (!Number.isFinite(t) || !Number.isFinite(b) || seen.has(b)) continue;
    seen.add(b);
    if (obj.s === 1) {
      seqs.push({ t, b, s: 1, k: obj.k === 8 ? 8 : 9 });
    } else {
      entries.push({ t, b });
    }
  }
  entries.sort((x, y) => x.t - y.t);
  seqs.sort((x, y) => x.b - y.b);
  return { entries, seqs };
}

/** 录制期侧车只追加：只读取新增的完整行，并合并并发读取。文件替换/截短时重新加载。 */
export class SeekIndexReader {
  private entries: SeekEntry[] = [];
  private seqs: SeekEntry[] = [];
  private seen = new Map<number, SeekEntry>();
  private offset = 0;
  private version: { dev: bigint; ino: bigint; size: bigint; mtime: bigint } | null = null;
  private inflight: Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> | null = null;

  constructor(private readonly filePath: string) {}

  load(): Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> {
    if (this.inflight) return this.inflight;
    this.inflight = this.read().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private reset(): void {
    this.entries = [];
    this.seqs = [];
    this.seen.clear();
    this.offset = 0;
    this.version = null;
  }

  private async read(): Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> {
    const handle = await open(seekSidecarPath(this.filePath), 'r').catch(() => null);
    if (!handle) {
      this.reset();
      return { entries: this.entries, seqs: this.seqs };
    }
    try {
      const s = await handle.stat({ bigint: true });
      const previous = this.version;
      if (previous && (s.dev !== previous.dev || s.ino !== previous.ino || s.size < previous.size ||
        (s.size === previous.size && s.mtimeNs !== previous.mtime))) this.reset();
      let sortEntries = false;
      let sortSeqs = false;
      const size = Number(s.size);
      let position = this.offset;
      let carry: Buffer = Buffer.alloc(0);
      while (position < size) {
        const buf = Buffer.alloc(Math.min(64 * 1024, size - position));
        const { bytesRead } = await handle.read(buf, 0, buf.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(10);
        if (end < 0) {
          // 正常条目不足百字节；坏掉的无界尾行不能占满内存。
          if (data.length > 64 * 1024) throw new Error('seek index line too large');
          carry = data;
          continue;
        }
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (!obj || typeof obj !== 'object') continue;
          const t = Number(obj.t);
          const b = Number(obj.b);
          if (!Number.isFinite(t) || !Number.isFinite(b)) continue;
          const previousEntry = this.seen.get(b);
          // 后台补扫追加的真值修正旧条目，不能让最早的坏时间戳永久遮住修复结果。
          if (previousEntry && (previousEntry.s === 1) === (obj.s === 1)) {
            if (previousEntry.t !== t) {
              previousEntry.t = t;
              if (obj.s !== 1) sortEntries = true;
            }
            if (obj.s === 1) previousEntry.k = obj.k === 8 ? 8 : 9;
            continue;
          }
          if (previousEntry) {
            const list = previousEntry.s === 1 ? this.seqs : this.entries;
            list.splice(list.indexOf(previousEntry), 1);
          }
          if (obj.s === 1) {
            if (b < (this.seqs[this.seqs.length - 1]?.b ?? -Infinity)) sortSeqs = true;
            const entry: SeekEntry = { t, b, s: 1, k: obj.k === 8 ? 8 : 9 };
            this.seqs.push(entry);
            this.seen.set(b, entry);
          } else {
            if (t < (this.entries[this.entries.length - 1]?.t ?? -Infinity)) sortEntries = true;
            const entry: SeekEntry = { t, b };
            this.entries.push(entry);
            this.seen.set(b, entry);
          }
        }
        carry = Buffer.from(data.subarray(end + 1));
        this.offset = position - carry.length;
        // 大型旧索引首次读入时给录制、SSE 和其他请求让出事件循环。
        if (position < size) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (sortEntries) this.entries.sort((a, b) => a.t - b.t);
      if (sortSeqs) this.seqs.sort((a, b) => a.b - b.b);
      this.version = { dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeNs };
      return { entries: this.entries, seqs: this.seqs };
    } finally {
      await handle.close();
    }
  }
}

/** 目标时间戳的起播条目：最后一个小于等于目标的关键帧。 */
export function lookupSeekEntry(entries: SeekEntry[], targetMs: number): SeekEntry | null {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (entries[mid]!.t <= targetMs) low = mid + 1;
    else high = mid;
  }
  return entries[low - 1] ?? null;
}

/** 起播点前面最近的视频/音频序列头（解码器初始化用）。 */
export function pickFeedSeqHeaders(seqs: SeekEntry[], beforeOffset: number): SeekEntry[] {
  let video: SeekEntry | null = null;
  let audio: SeekEntry | null = null;
  for (const seq of seqs) {
    if (seq.b >= beforeOffset) break;
    if (seq.k === 9) video = seq;
    else audio = seq;
  }
  return [...(audio ? [audio] : []), ...(video ? [video] : [])];
}

/**
 * 校验条目与真实文件对得上：偏移处必须是关键帧视频标签、时间戳接近。
 * 对不上=索引失效（文件被外部改动），按「失效重建绝不硬播」处理。
 */
export async function validateSeekEntry(filePath: string, entry: SeekEntry): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(13);
      const { bytesRead } = await handle.read(buf, 0, 13, entry.b);
      if (bytesRead < 13) return false;
      const tagType = buf[0]!;
      const data0 = buf[11]!;
      const data1 = buf[12]!;
      if (tagType !== 9 || !isKeyframeVideoTag(tagType, data0, data1)) return false;
      const ts = ((buf[4]! << 16) | (buf[5]! << 8) | buf[6]! | ((buf[7]! & 0xff) << 24)) >>> 0;
      return Math.abs(ts - entry.t) <= 1500;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export interface ScanOptions {
  from: number;
  to: number;
  onEntry: (entry: SeekEntry) => void;
  onProgress?: (scannedBytes: number) => void;
  /** 取消标记：置 aborted 即停（关停/让位时用）。 */
  signal?: { aborted: boolean };
}

/**
 * 顺序扫描补建索引（启动补扫/失效重建）：分块顺序读、逐标签解析，
 * 只记关键帧与序列头。每块之间让出事件循环，让位录制写盘。
 */
export async function scanSeekIndex(filePath: string, opts: ScanOptions): Promise<void> {
  const CHUNK = 2 * 1024 * 1024;
  const handle = await open(filePath, 'r');
  try {
    let pos = opts.from;
    let carry: Buffer = Buffer.alloc(0);
    // FLV 头（13B）+ PreviousTagSize 不是标签；从头扫时跳过，否则把头当标签解析全盘皆错。
    let skip = opts.from === 0 ? 13 : 0;
    while (pos < opts.to && !opts.signal?.aborted) {
      const want = Math.min(CHUNK, opts.to - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let off = skip;
      skip = 0;
      const base = pos - carry.length;
      while (off + 11 <= data.length) {
        const tagType = data[off]!;
        const dataSize = (data[off + 1]! << 16) | (data[off + 2]! << 8) | data[off + 3]!;
        const tagLen = 11 + dataSize + 4;
        if (off + tagLen > data.length) break;
        const ts = ((data[off + 4]! << 16) | (data[off + 5]! << 8) | data[off + 6]! | ((data[off + 7]! & 0xff) << 24)) >>> 0;
        const abs = base + off;
        if (tagType === 9 || tagType === 8) {
          const d0 = data[off + 11]!;
          const d1 = data[off + 12]!;
          if (tagType === 9 && isVideoSeqHeader(d0, d1)) {
            opts.onEntry({ t: ts, b: abs, s: 1, k: 9 });
          } else if (tagType === 8 && isAudioSeqHeader(d0, d1)) {
            opts.onEntry({ t: ts, b: abs, s: 1, k: 8 });
          } else if (tagType === 9 && isKeyframeVideoTag(tagType, d0, d1)) {
            opts.onEntry({ t: ts, b: abs });
          }
        }
        off += tagLen;
      }
      carry = Buffer.from(data.subarray(off));
      pos += bytesRead;
      opts.onProgress?.(pos);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await handle.close();
  }
}

export async function moveSeekIndexSidecar(from: string, to: string): Promise<void> {
  try {
    await rename(seekSidecarPath(from), seekSidecarPath(to));
    moveSeekCoverage(from, to);
  } catch {
    // 无侧车或目标不可写：best-effort，不影响主流程。
  }
}

export async function removeSeekIndexSidecar(filePath: string): Promise<void> {
  await rm(seekSidecarPath(filePath), { force: true }).catch(() => undefined);
  clearSeekCoverage(filePath);
}

/**
 * 覆盖状态（进程内记忆）：记录「哪些字节区段的索引是完整的」。
 * 写入器从字节 0 开始=全覆盖；从中间续写（重启/续录）留下前缀缺口，由启动补扫填平。
 */
interface SeekCoverageState {
  /** 前缀覆盖终点：[0, prefixCoveredTo) 的索引完整。 */
  prefixCoveredTo: number;
  /** 当前写入段起始偏移；null=无写入。 */
  writerFrom: number | null;
  writerActive: boolean;
  /** 已落盘的最大条目偏移（诊断用）。 */
  indexedTo: number;
  scan: { running: boolean; scanned: number; target: number; failed: boolean; from: number } | null;
}

const coverage = new Map<string, SeekCoverageState>();

function coverageOf(filePath: string): SeekCoverageState {
  let state = coverage.get(filePath);
  if (!state) {
    state = {
      prefixCoveredTo: 0,
      writerFrom: null,
      writerActive: false,
      indexedTo: 0,
      scan: null,
    };
    coverage.set(filePath, state);
  }
  return state;
}

export function noteSeekCoverage(filePath: string, writerFrom: number): void {
  const state = coverageOf(filePath);
  state.writerFrom = writerFrom;
  state.writerActive = true;
  if (writerFrom === 0) state.prefixCoveredTo = Number.POSITIVE_INFINITY;
}

export function markSeekIndexed(filePath: string, offset: number): void {
  const state = coverageOf(filePath);
  if (offset > state.indexedTo) state.indexedTo = offset;
}

export function endSeekWriter(filePath: string): void {
  coverageOf(filePath).writerActive = false;
}

export function beginSeekScan(filePath: string, from: number, target: number): void {
  const state = coverageOf(filePath);
  state.scan = { running: true, scanned: from, target, failed: false, from };
}

export function progressSeekScan(filePath: string, scanned: number): void {
  const state = coverageOf(filePath);
  if (state.scan) state.scan.scanned = scanned;
}

export function finishSeekScan(filePath: string, ok: boolean): void {
  const state = coverageOf(filePath);
  if (!state.scan) return;
  if (ok) {
    state.scan = null;
    state.prefixCoveredTo = Math.max(state.prefixCoveredTo, Number.POSITIVE_INFINITY);
  } else {
    state.scan.running = false;
    state.scan.failed = true;
  }
}

export function resetSeekCoverageForTest(): void {
  coverage.clear();
}

export type SeekIndexState = 'ready' | 'building' | 'missing';

export interface SeekIndexInfo {
  seekIndexState: SeekIndexState;
  seekIndexProgress?: number;
}

/**
 * 计算索引状态（API/SSE 用）：
 * ready=覆盖完整可跳播；building=补扫中（进度 0-100）；missing=无索引且没在补建。
 */
export function seekIndexOf(filePath: string, sidecarExists: boolean): SeekIndexInfo {
  const state = coverage.get(filePath);
  if (!state) {
    return sidecarExists ? { seekIndexState: 'ready' } : { seekIndexState: 'missing' };
  }
  if (state.scan) {
    const span = Math.max(1, state.scan.target - state.scan.from);
    const pct = Math.min(99, Math.max(0, Math.round(((state.scan.scanned - state.scan.from) / span) * 100)));
    return { seekIndexState: 'building', seekIndexProgress: pct };
  }
  const covered = state.prefixCoveredTo >= (state.writerFrom ?? Number.POSITIVE_INFINITY);
  if (covered) return { seekIndexState: 'ready' };
  if (state.writerFrom !== null || sidecarExists) return { seekIndexState: 'building', seekIndexProgress: 0 };
  return { seekIndexState: 'missing' };
}

function moveSeekCoverage(from: string, to: string): void {
  const state = coverage.get(from);
  if (state) {
    coverage.delete(from);
    coverage.set(to, state);
  }
}

function clearSeekCoverage(filePath: string): void {
  coverage.delete(filePath);
}

/** 顺序读取文件头的序列头标签（补扫未覆盖时的兜底），返回 [offset,length]。 */
export async function readHeadSeqTags(filePath: string): Promise<Array<{ offset: number; length: number }>> {
  const out: Array<{ offset: number; length: number }> = [];
  try {
    const handle = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      let off = 13;
      while (off + 13 <= bytesRead) {
        const tagType = buf[off]!;
        const dataSize = (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!;
        const tagLen = 11 + dataSize + 4;
        if (off + tagLen > bytesRead) break;
        const d0 = buf[off + 11]!;
        const d1 = buf[off + 12]!;
        const isSeq =
          (tagType === 9 && isVideoSeqHeader(d0, d1)) ||
          (tagType === 8 && isAudioSeqHeader(d0, d1));
        if (isSeq) out.push({ offset: off, length: tagLen });
        else if (tagType === 8 || tagType === 9) break;
        off += tagLen;
      }
    } finally {
      await handle.close();
    }
  } catch {
    // 文件不可读：由调用方按「文件不可读」报人话。
  }
  return out;
}

/** 文件大小快照（起流尾界=请求时刻已写尾部，不追帧）。 */
export async function fileSizeSnapshot(filePath: string): Promise<number | null> {
  const s = await stat(filePath).catch(() => null);
  return s ? s.size : null;
}

/** 供起流用的顺序读流（从文件读字节区间）。 */
export function createSeekByteStream(filePath: string, from: number, to: number): NodeJS.ReadableStream {
  return createReadStream(filePath, { start: from, end: to - 1 });
}
