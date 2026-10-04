import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { AppError } from "../types/error.js";
import type { Recording } from "../types/index.js";
import {
  SeekIndexWriter,
  beginSeekScan,
  finishSeekScan,
  fileSizeSnapshot,
  SeekIndexReader,
  lookupSeekEntry,
  pickFeedSeqHeaders,
  progressSeekScan,
  readHeadSeqTags,
  scanSeekIndex,
  seekIndexOf,
  seekSidecarPath,
  validateSeekEntry,
  type SeekEntry,
  type SeekIndexInfo,
} from "../storage/seek-index.js";
import type { Services } from "./services.js";

/**
 * 跳播服务（正在录的这条，拖到哪 1 秒内从哪播）。
 *
 * 定位靠录制期顺手记的关键帧字节索引；起流把「FLV 头+序列头+关键帧起的字节段」
 * 直通输出为 FLV 流（不转封装不回扫，成本与文件大小无关；标签时间戳=源时间轴）。
 * 同一回看快照支持按字节续读；换源杀旧起新，每个录像最多一路读。
 */

/** 跳播独立并发小上限（与 clip 导出 6 分开计数、互不挤占）：只拒新、不杀在途。 */
export const MAX_SEEK_SESSIONS = 4;

export interface SeekFeedPlan {
  filePath: string;
  /** 先喂的前缀：13 字节 FLV 头 + 起播点前最近的音视频序列头（解码器初始化必需）。 */
  prefix: Buffer;
  from: number;
  to: number;
  /** 供给速率上限（字节/毫秒）：burst 之后按码率倍数供，防瞬灌砸爆播放器缓存。 */
  paceBytesPerMs?: number;
  /** 馈送取证不使用 data 监听，避免 HTTP 消费端接入前把可读流提前切为 flowing。 */
  onFeed?: (bytes: number) => void;
}

export interface SeekProc {
  /** 输出字节流（FLV）。 */
  stdout: Readable;
  /** 切流：销毁读流（无进程可杀；历史上的 SIGTERM 语义由此取代）。 */
  kill: () => void;
  done: Promise<void>;
}

export type SeekProcFactory = (plan: SeekFeedPlan) => SeekProc;

/** 默认起流：直通 FLV 字节流（FLV 头+序列头+从关键帧偏移起的标签），零进程。
 *  不用 ffmpeg 转封装的原因（实测）：ffmpeg 任何容器输出都会把时间轴归零并吞掉
 *  copyts/output_ts_offset 等保持手段；直通的标签时间戳=源时间（录制时间轴），
 *  真值显示免对齐，TTFB 只剩读盘延迟。切流=销毁读流，天然无进程累积。 */
/** 起流供给节流：先冲一小段（保首帧延迟），之后按码率倍数供。
 *  不限速时整窗（可达几十 MB）会在百毫秒级瞬灌砸爆播放器缓存（实测其内部
 *  丢 unconsumed 字节→解封装失步），而 socket 背压在本机根本不咬合。 */
const FEED_BURST_BYTES = 4 * 1024 * 1024;
const FEED_DEFAULT_PACE_BYTES_PER_MS = 4_000; // 兼底 ≈32Mbps，无索引估值时用

export function defaultSeekStreamFactory(plan: SeekFeedPlan): SeekProc {
  const out = new PassThrough();
  let reader: ReturnType<typeof createReadStream> | null = null;
  let killed = false;
  const pace =
    plan.paceBytesPerMs && plan.paceBytesPerMs > 0
      ? plan.paceBytesPerMs
      : FEED_DEFAULT_PACE_BYTES_PER_MS;
  const done = new Promise<void>((resolve) => {
    out.on("end", () => resolve());
    out.on("close", () => resolve());
  });
  const t0 = Date.now();
  let fed = 0;
  void (async () => {
    try {
      if (killed) return;
      out.write(plan.prefix);
      if (plan.prefix.length) plan.onFeed?.(plan.prefix.length);
      if (plan.from >= plan.to) { out.end(); return; }
      reader = createReadStream(plan.filePath, {
        start: plan.from,
        end: plan.to - 1,
      });
      for await (const chunk of reader) {
        if (killed) break;
        fed += chunk.length;
        plan.onFeed?.(chunk.length);
        if (!out.write(chunk as Buffer)) {
          // 源侧背压：消费端排空前不再读盘（close 也放行，防 kill 后悬挂）。
          await new Promise<void>((resolve) => {
            const settle = () => {
              out.off("drain", settle);
              out.off("close", settle);
              resolve();
            };
            out.once("drain", settle);
            out.once("close", settle);
          });
        }
        // burst 之后按码率限速供给。
        const due = FEED_BURST_BYTES + pace * (Date.now() - t0);
        if (fed > due) {
          const waitMs = Math.min(500, Math.ceil((fed - due) / pace));
          await new Promise<void>((resolve) => {
            const early = () => {
              clearTimeout(timer);
              out.off("close", early);
              resolve();
            };
            const timer = setTimeout(early, waitMs);
            out.once("close", early);
          });
          if (killed) break;
        }
      }
      reader.destroy();
      out.end();
    } catch (error) {
      if (!killed) out.destroy(error as Error);
    }
  })();
  return {
    stdout: out,
    kill: () => {
      killed = true;
      reader?.destroy();
      out.destroy();
    },
    done,
  };
}

interface SeekSnapshot {
  recordingId: string;
  second: number;
  startSecond: number;
  lastUsed: number;
  plan: SeekFeedPlan;
}

export class SeekRangeError extends Error {
  constructor(readonly total: number) { super('Requested seek range is not satisfiable'); }
}

/** 单个 HTTP 字节范围，返回右开区间；支持续读、限定范围和尾部范围。 */
export function seekByteRange(header: string | undefined, total: number): { from: number; to: number } {
  if (header === undefined) return { from: 0, to: total };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new SeekRangeError(total);
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) throw new SeekRangeError(total);
    return { from: Math.max(0, total - count), to: total };
  }
  const from = Number(match[1]);
  const last = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(last) || from >= total || last < from) throw new SeekRangeError(total);
  return { from, to: Math.min(total, last + 1) };
}

interface SeekSession {
  recordingId: string;
  /** 会话流水号（日志关联用）。 */
  sid: number;
  second: number;
  startSecond: number;
  proc: SeekProc;
}

export class SeekService {
  private sessions = new Map<string, SeekSession>();
  private warm = new Map<string, SeekIndexReader>();
  private invalidEntries = new Map<string, Set<string>>();
  private snapshots = new Map<string, SeekSnapshot>();
  private opening = new Map<string, object>();
  private scans = new Map<string, Promise<void>>();
  private scanSignals = new Map<string, { aborted: boolean }>();
  /** 会话流水号：与录制 id 一起进日志，一次跳播的全链（起/杀/首包/结束/错误）可串起来。 */
  private sessionSeq = 0;

  private log(...args: unknown[]): void {
    console.log("[seek]", ...args);
  }

  constructor(
    private readonly services: Services,
    private readonly procFactory: SeekProcFactory = defaultSeekStreamFactory,
  ) {
    // 录制一停、轨道退场：立即收掉该录像的在途跳播会话（作用范围=仅正在录这条）。
    services.events.on((event) => {
      if (event.type === "recording:updated") {
        const state = event.data.state;
        if (state !== "recording" && state !== "reconnecting") {
          this.killSession(event.data.id);
          this.warm.delete(event.data.filePath ?? "");
          this.invalidEntries.delete(event.data.filePath ?? "");
          this.clearSnapshots(event.data.id);
        }
      } else if (event.type === "recording:deleted") {
        this.killSession(event.data.id);
        this.clearSnapshots(event.data.id);
      }
    });
  }

  /** API/SSE 展示字段：仅「正在录的 FLV」给索引状态，其余行不带字段（历史零改动）。 */
  seekInfo(rec: Recording): SeekIndexInfo | undefined {
    if (!rec.filePath) return undefined;
    if (rec.state !== "recording" && rec.state !== "reconnecting")
      return undefined;
    if (!rec.filePath.endsWith(".flv")) return { seekIndexState: "missing" };
    return seekIndexOf(rec.filePath, existsSync(seekSidecarPath(rec.filePath)));
  }

  /** 给录制行附加索引状态字段（列表响应/SSE 用）。 */
  attachSeekFields<T extends Recording>(rec: T): T {
    const info = this.seekInfo(rec);
    if (!info) return rec;
    return {
      ...rec,
      seekIndexState: info.seekIndexState,
      ...(info.seekIndexProgress !== undefined
        ? { seekIndexProgress: info.seekIndexProgress }
        : {}),
    };
  }

  private requireSeekable(rec: Recording): string {
    if (!rec.filePath) {
      throw new AppError("RECORDING_NOT_AVAILABLE", "录制文件不存在", {
        details: { recordingId: rec.id },
      });
    }
    if (rec.state !== "recording" && rec.state !== "reconnecting") {
      throw new AppError("RECORDING_NOT_AVAILABLE", "仅录制中的录像支持跳播", {
        details: { recordingId: rec.id, state: rec.state },
      });
    }
    if (!rec.filePath.endsWith(".flv")) {
      throw new AppError("RECORDING_NOT_AVAILABLE", "该录像格式暂不支持跳播", {
        details: { recordingId: rec.id },
      });
    }
    return rec.filePath;
  }

  /** 每个文件独立维护增量索引，并发预热共用同一次读取。 */
  private loadIndex(filePath: string): Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> {
    let reader = this.warm.get(filePath);
    if (!reader) {
      reader = new SeekIndexReader(filePath);
      this.warm.set(filePath, reader);
    }
    return reader.load();
  }

  private invalidate(filePath: string): void {
    this.warm.delete(filePath);
  }

  /**
   * 解析起播目标：查索引命中前一个关键帧、校验与真实文件对得上。
   * 索引建立中=显式「建立中」拒绝；索引失效=触发后台重建绝不硬播。
   */
  private async resolveTarget(
    rec: Recording,
    filePath: string,
    second: number,
  ): Promise<{
    entry: SeekEntry;
    startSecond: number;
    seqs: SeekEntry[];
    pace: number;
  }> {
    const info = seekIndexOf(filePath, existsSync(seekSidecarPath(filePath)));
    if (info.seekIndexState === "building") {
      this.log(
        `reject building rec=${rec.id} second=${second} progress=${info.seekIndexProgress ?? 0}`,
      );
      void this.startScan(filePath, rec.id);
      throw new AppError(
        "RECORDING_START_FAILED",
        "正在建立定位索引，请稍后再试",
        {
          retryable: true,
          details: {
            recordingId: rec.id,
            seekIndexProgress: info.seekIndexProgress ?? 0,
          },
        },
      );
    }
    const loaded = await this.loadIndex(filePath);
    const invalid = this.invalidEntries.get(filePath);
    const entries = invalid ? loaded.entries.filter(entry => !invalid.has(`${entry.b}:${entry.t}`)) : loaded.entries;
    const seqs = loaded.seqs;
    if (entries.length === 0) {
      // 在录但索引缺失（写入降级/被清理）：后台重建，先明确告知不可用。
      this.log(`reject missing-index rec=${rec.id} second=${second}`);
      void this.startScan(filePath, rec.id);
      throw new AppError(
        "RECORDING_START_FAILED",
        "正在建立定位索引，请稍后再试",
        {
          retryable: true,
          details: { recordingId: rec.id },
        },
      );
    }
    const targetMs = Math.max(0, Math.floor(second * 1000));
    const entry = lookupSeekEntry(entries, targetMs) ?? entries[0]!;
    // gap 检测：目标超出索引覆盖（末条）一大截=写入器可能中途降级、索引变陈旧。
    // 宁可显式「建立中」触发补扫自愈（读真文件补条目），也不硬吸旧条目（曾导致拖哪都跳同一位置）。
    const lastEntry = entries[entries.length - 1];
    if (lastEntry && targetMs > lastEntry.t + 8_000) {
      this.log(
        `reject index-gap rec=${rec.id} second=${second} covered-to=${lastEntry.t}ms`,
      );
      this.invalidate(filePath);
      void this.startScan(filePath, rec.id);
      throw new AppError(
        "RECORDING_START_FAILED",
        "正在建立定位索引，请稍后再试",
        {
          retryable: true,
          details: { recordingId: rec.id, coveredToMs: lastEntry.t },
        },
      );
    }
    // 供给速率估值：索引末条的字节/毫秒均值×4 倍余量（无有效估值用 32Mbps 兼底），限速防瞬灌。
    const last = lastEntry;
    const est = last && last.t > 1000 ? last.b / last.t : 0;
    const pace = est > 0 ? Math.max(250, Math.min(est * 4, 8000)) : 4000;
    const valid = await validateSeekEntry(filePath, entry);
    if (!valid) {
      let rejected = this.invalidEntries.get(filePath);
      if (!rejected) {
        rejected = new Set();
        this.invalidEntries.set(filePath, rejected);
      }
      rejected.add(`${entry.b}:${entry.t}`);
      this.log(
        `reject invalid-entry rec=${rec.id} second=${second} entry=t${entry.t},b${entry.b}`,
      );
      this.invalidate(filePath);
      void this.startScan(filePath, rec.id);
      throw new AppError(
        "RECORDING_START_FAILED",
        "定位索引已失效，正在重建，请稍后再试",
        {
          retryable: true,
          details: { recordingId: rec.id },
        },
      );
    }
    return { entry, startSecond: entry.t / 1000, seqs, pace };
  }

  /** pointerdown 只查索引；提交时准备稳定字节快照，续读不会重复前缀或追入新录制内容。 */
  async prewarm(rec: Recording, second: number, prepareStream = false): Promise<{ startSecond: number; streamToken?: string }> {
    const filePath = this.requireSeekable(rec);
    if (!prepareStream) {
      const { startSecond } = await this.resolveTarget(rec, filePath, second);
      return { startSecond };
    }
    const snapshot = await this.prepareSnapshot(rec, second);
    const token = randomUUID();
    this.pruneSnapshots();
    this.snapshots.set(token, snapshot);
    return { startSecond: snapshot.startSecond, streamToken: token };
  }

  private pruneSnapshots(): void {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [token, snapshot] of this.snapshots) {
      if (snapshot.lastUsed < cutoff) this.snapshots.delete(token);
    }
    while (this.snapshots.size >= 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  private clearSnapshots(recordingId: string): void {
    this.opening.delete(recordingId);
    for (const [token, snapshot] of this.snapshots) {
      if (snapshot.recordingId === recordingId) this.snapshots.delete(token);
    }
  }

  private async prepareSnapshot(rec: Recording, second: number): Promise<SeekSnapshot> {
    const filePath = this.requireSeekable(rec);
    const { entry, startSecond, seqs, pace } = await this.resolveTarget(rec, filePath, second);
    const tail = await fileSizeSnapshot(filePath);
    if (tail === null) throw new AppError("RECORDING_NOT_AVAILABLE", "录像文件不可读", { recordingId: rec.id });
    if (tail <= entry.b + 13) throw new AppError("RECORDING_NOT_AVAILABLE", "该位置暂无可播放内容", { retryable: true, recordingId: rec.id });
    const prefix = await this.buildPrefix(filePath, entry, seqs);
    return {
      recordingId: rec.id, second, startSecond, lastUsed: Date.now(),
      plan: { filePath, prefix, from: entry.b, to: tail, paceBytesPerMs: pace },
    };
  }

  /** 起流/续读：Range 是「前缀+录像区段」中的偏移，任何一次读取都限于同一快照。 */
  async openStream(
    rec: Recording,
    second: number,
    options: { streamToken?: string; range?: string; signal?: AbortSignal } = {},
  ): Promise<{ stream: Readable; startSecond: number; total: number; from: number; to: number; partial: boolean }> {
    const filePath = this.requireSeekable(rec);
    const ticket = {};
    this.opening.set(rec.id, ticket);
    try {
      const snapshot = options.streamToken ? this.snapshots.get(options.streamToken) : await this.prepareSnapshot(rec, second);
      if (!snapshot || snapshot.recordingId !== rec.id || snapshot.second !== second || snapshot.plan.filePath !== filePath) {
        throw new AppError("RECORDING_NOT_AVAILABLE", "回看会话已过期，请重试", { retryable: true, recordingId: rec.id });
      }
      const plan = snapshot.plan;
      const total = plan.prefix.length + plan.to - plan.from;
      // 旧 URL 没有稳定快照，拒绝续读，不能用新的前缀/尾界冒充旧响应的后续字节。
      if (options.range && !options.streamToken) throw new SeekRangeError(total);
      const range = seekByteRange(options.range, total);
      if (options.signal?.aborted || this.opening.get(rec.id) !== ticket) {
        throw new AppError("RECORDING_NOT_AVAILABLE", "回看请求已取消", { retryable: true, recordingId: rec.id });
      }
      // 所有异步准备之后再检查容量和替换旧流，避免并发起流越过上限或旧请求杀新流。
      this.requireSeekable(this.services.recordings.get(rec.id) ?? rec);
      if (!this.sessions.has(rec.id) && this.sessions.size >= MAX_SEEK_SESSIONS) {
        throw new AppError("CONCURRENT_LIMIT_REACHED", "跳播并发已满，请稍后再试", { retryable: true, recordingId: rec.id });
      }
      this.killSession(rec.id);
      snapshot.lastUsed = Date.now();
      const prefixEnd = Math.min(plan.prefix.length, range.to);
      const prefix = range.from < prefixEnd ? plan.prefix.subarray(range.from, prefixEnd) : Buffer.alloc(0);
      const from = plan.from + Math.max(0, range.from - plan.prefix.length);
      const to = plan.from + Math.max(0, range.to - plan.prefix.length);
      const sid = ++this.sessionSeq;
      const startedAt = Date.now();
      let fedBytes = 0;
      this.log(`start sid=${sid} rec=${rec.id} second=${second} start=${snapshot.startSecond} range=${range.from}-${range.to}/${total}`);
      const proc = this.procFactory({ ...plan, prefix, from, to, onFeed: (bytes) => {
        if (fedBytes === 0) this.log(`first-byte sid=${sid} +${Date.now() - startedAt}ms`);
        fedBytes += bytes;
      } });
      const session: SeekSession = { recordingId: rec.id, sid, second, startSecond: snapshot.startSecond, proc };
      this.sessions.set(rec.id, session);
      const abort = () => {
        if (this.sessions.get(rec.id) === session) this.killSession(rec.id);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      void proc.done.then(() => {
        options.signal?.removeEventListener('abort', abort);
        if (this.sessions.get(rec.id) === session) this.sessions.delete(rec.id);
        this.log(`end sid=${sid} rec=${rec.id} fed=${fedBytes}B ${Date.now() - startedAt}ms`);
      });
      proc.stdout.once('close', () => { if (!proc.stdout.readableEnded) abort(); });
      return { stream: proc.stdout, startSecond: snapshot.startSecond, total, ...range, partial: options.range !== undefined };
    } finally {
      if (this.opening.get(rec.id) === ticket) this.opening.delete(rec.id);
    }
  }

  private async buildPrefix(
    filePath: string,
    entry: SeekEntry,
    seqs: SeekEntry[],
  ): Promise<Buffer> {
    const parts: Buffer[] = [];
    const handle = await import("node:fs/promises").then((m) =>
      m.open(filePath, "r"),
    );
    try {
      const head = Buffer.alloc(13);
      const { bytesRead } = await handle.read(head, 0, 13, 0);
      if (bytesRead < 13 || head.subarray(0, 3).toString("ascii") !== "FLV") {
        throw new AppError("RECORDING_NOT_AVAILABLE", "录像文件不可读", {});
      }
      parts.push(head);
      let chosen = pickFeedSeqHeaders(seqs, entry.b);
      if (chosen.length === 0) {
        // 索引里没有序列头记录：直接从文件头现读（序列头通常就在文件开头）。
        const headTags = await readHeadSeqTags(filePath);
        chosen = headTags.map((tag) => ({ t: 0, b: tag.offset }));
        for (const tag of headTags) {
          const buf = Buffer.alloc(tag.length);
          await handle.read(buf, 0, tag.length, tag.offset);
          parts.push(buf);
        }
      } else {
        for (const seq of chosen) {
          const lenBuf = Buffer.alloc(11);
          const r = await handle.read(lenBuf, 0, 11, seq.b);
          if (r.bytesRead < 11) continue;
          const dataLen = (lenBuf[1]! << 16) | (lenBuf[2]! << 8) | lenBuf[3]!;
          const buf = Buffer.alloc(11 + dataLen + 4);
          await handle.read(buf, 0, buf.length, seq.b);
          parts.push(buf);
        }
      }
    } finally {
      await handle.close();
    }
    return Buffer.concat(parts);
  }

  /** 杀掉某录像的在途会话（换秒/录制停止/删除时）。 */
  killSession(recordingId: string): void {
    const session = this.sessions.get(recordingId);
    if (!session) return;
    this.log(
      `kill sid=${session.sid} rec=${recordingId} second=${session.second} (换秒/停录/删除)`,
    );
    this.sessions.delete(recordingId);
    session.proc.kill();
  }

  /**
   * 启动补扫：把「功能上线/重启前写入的前缀」补进索引（后台顺序读、让位写盘）。
   * 建好前跳播显式不可用，建好自动恢复。
   */
  async startupScan(): Promise<number> {
    let count = 0;
    for (const state of ["recording", "reconnecting"] as const) {
      const rows = this.services.recordings.list({
        page: 1,
        pageSize: 100,
        state,
      }).items;
      for (const rec of rows) {
        if (!rec.filePath || !rec.filePath.endsWith(".flv")) continue;
        const info = seekIndexOf(
          rec.filePath,
          existsSync(seekSidecarPath(rec.filePath)),
        );
        if (info.seekIndexState === "ready") continue;
        void this.startScan(rec.filePath, rec.id);
        count += 1;
      }
    }
    return count;
  }

  /** 后台顺序扫描补建/重建索引；同一文件不重复起扫，重复调用拿到的是同一个在飞 Promise。 */
  startScan(filePath: string, recId?: string): Promise<void> {
    const inflight = this.scans.get(filePath);
    if (inflight) return inflight;
    const run = this.runScan(filePath, recId).finally(() => {
      this.scans.delete(filePath);
    });
    this.scans.set(filePath, run);
    return run;
  }

  private async runScan(filePath: string, recId?: string): Promise<void> {
    const signal = { aborted: false };
    this.scanSignals.set(filePath, signal);
    const size = (await fileSizeSnapshot(filePath)) ?? 0;
    this.log(`scan-begin file=${filePath} bytes=${size}`);
    beginSeekScan(filePath, 0, size);
    this.invalidate(filePath);
    this.emitSeekState(recId);
    let lastEmit = 0;
    // 扫描期持有 writer 批量追加；不登记覆盖（扫描不是写入段）。
    const writer = await SeekIndexWriter.open(filePath, 0, {
      trackCoverage: false,
    });
    try {
      await scanSeekIndex(filePath, {
        from: 0,
        to: size,
        signal,
        onEntry: (entry) => {
          writer?.note(entry);
        },
        onProgress: (scanned) => {
          progressSeekScan(filePath, scanned);
          const now = Date.now();
          if (now - lastEmit > 2000) {
            lastEmit = now;
            this.emitSeekState(recId);
          }
        },
      });
      finishSeekScan(filePath, !signal.aborted);
      this.log(`scan-done file=${filePath} ok=${!signal.aborted}`);
    } catch {
      finishSeekScan(filePath, false);
      this.log(`scan-failed file=${filePath}`);
    } finally {
      await writer?.close();
      this.scanSignals.delete(filePath);
      this.invalidate(filePath);
      this.emitSeekState(recId);
    }
  }

  private emitSeekState(recId?: string): void {
    if (!recId) return;
    try {
      const rec = this.services.recordings.get(recId);
      if (!rec) return;
      this.services.events.emit({
        type: "recording:updated",
        data: this.attachSeekFields(rec),
      });
    } catch {
      // 只读广播：关停/库已关等异常不反压扫描与调用方。
    }
  }

  /** 测试/关停：收掉全部会话与补扫。 */
  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.killSession(id);
    for (const signal of this.scanSignals.values()) signal.aborted = true;
    this.snapshots.clear();
    this.warm.clear();
    this.invalidEntries.clear();
    this.opening.clear();
  }
}
