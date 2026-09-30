import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { AppError } from '../types/error.js';
import type { Recording } from '../types/index.js';
import {
  SeekIndexWriter,
  beginSeekScan,
  finishSeekScan,
  fileSizeSnapshot,
  loadSeekIndex,
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
} from '../storage/seek-index.js';
import type { Services } from './services.js';

/**
 * 跳播服务（正在录的这条，拖到哪 1 秒内从哪播）。
 *
 * 定位靠录制期顺手记的关键帧字节索引；起流把「FLV 头+序列头+关键帧起的字节段」
 * 直通输出为 FLV 流（不转封装不回扫，成本与文件大小无关；标签时间戳=源时间轴）。
 * 同秒复用在途会话、换秒杀旧起新，任何时刻每个录像最多一路读。
 */

/** 跳播独立并发小上限（与 clip 导出 6 分开计数、互不挤占）：只拒新、不杀在途。 */
export const MAX_SEEK_SESSIONS = 4;
/** 同点复用的重放缓冲上限：覆盖「旧请求未断、新请求同秒接入」的间隙；超出后同秒新请求另起会话。 */
const REPLAY_CAP_BYTES = 8 * 1024 * 1024;

export interface SeekFeedPlan {
  filePath: string;
  /** 先喂的前缀：13 字节 FLV 头 + 起播点前最近的音视频序列头（解码器初始化必需）。 */
  prefix: Buffer;
  from: number;
  to: number;
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
export function defaultSeekStreamFactory(plan: SeekFeedPlan): SeekProc {
  const out = new PassThrough();
  let killed = false;
  const done = new Promise<void>((resolve) => {
    out.on('end', () => resolve());
    out.on('close', () => resolve());
  });
  void (async () => {
    try {
      out.write(plan.prefix);
      const reader = createReadStream(plan.filePath, {
        start: plan.from,
        end: plan.to - 1,
      });
      for await (const chunk of reader) {
        if (killed) break;
        if (!out.write(chunk as Buffer)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
      }
      reader.destroy();
      out.end();
    } catch {
      // 消费端断开/文件读失败：交给 close 收束，不反压。
      out.end();
    }
  })();
  return {
    stdout: out,
    kill: () => {
      killed = true;
      out.end();
    },
    done,
  };
}

interface SeekSession {
  recordingId: string;
  second: number;
  startSecond: number;
  proc: SeekProc;
  replay: Buffer[];
  replayBytes: number;
  overflow: boolean;
  subscribers: Set<PassThrough>;
}

export class SeekService {
  private sessions = new Map<string, SeekSession>();
  private warm = new Map<string, { entries: SeekEntry[]; seqs: SeekEntry[]; size: number }>();
  private scans = new Map<string, Promise<void>>();
  private scanSignals = new Map<string, { aborted: boolean }>();

  constructor(
    private readonly services: Services,
    private readonly procFactory: SeekProcFactory = defaultSeekStreamFactory,
  ) {
    // 录制一停、轨道退场：立即收掉该录像的在途跳播会话（作用范围=仅正在录这条）。
    services.events.on((event) => {
      if (event.type === 'recording:updated') {
        const state = event.data.state;
        if (state !== 'recording' && state !== 'reconnecting') {
          this.killSession(event.data.id);
          this.warm.delete(event.data.filePath ?? '');
        }
      } else if (event.type === 'recording:deleted') {
        this.killSession(event.data.id);
      }
    });
  }

  /** API/SSE 展示字段：仅「正在录的 FLV」给索引状态，其余行不带字段（历史零改动）。 */
  seekInfo(rec: Recording): SeekIndexInfo | undefined {
    if (!rec.filePath) return undefined;
    if (rec.state !== 'recording' && rec.state !== 'reconnecting') return undefined;
    if (!rec.filePath.endsWith('.flv')) return { seekIndexState: 'missing' };
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
      throw new AppError('RECORDING_NOT_AVAILABLE', '录制文件不存在', {
        details: { recordingId: rec.id },
      });
    }
    if (rec.state !== 'recording' && rec.state !== 'reconnecting') {
      throw new AppError('RECORDING_NOT_AVAILABLE', '仅录制中的录像支持跳播', {
        details: { recordingId: rec.id, state: rec.state },
      });
    }
    if (!rec.filePath.endsWith('.flv')) {
      throw new AppError('RECORDING_NOT_AVAILABLE', '该录像格式暂不支持跳播', {
        details: { recordingId: rec.id },
      });
    }
    return rec.filePath;
  }

  /** 索引加载：带版本校验的短缓存——侧车只追加，大小变了（录制持续写入）即重载，
   *  避免预热快照过期把不同目标秒都吸到旧末条（真值错位）。 */
  private async loadIndex(filePath: string): Promise<{ entries: SeekEntry[]; seqs: SeekEntry[] }> {
    const sidecar = seekSidecarPath(filePath);
    const s = await stat(sidecar).catch(() => null);
    const cached = this.warm.get(filePath);
    if (cached && s && cached.size === s.size) return cached;
    const loaded = await loadSeekIndex(filePath);
    this.warm.set(filePath, { ...loaded, size: s?.size ?? -1 });
    return loaded;
  }

  private invalidate(filePath: string): void {
    this.warm.delete(filePath);
  }

  /**
   * 解析起播目标：查索引命中前一个关键帧、校验与真实文件对得上。
   * 索引建立中=显式「建立中」拒绝；索引失效=触发后台重建绝不硬播。
   */
  private async resolveTarget(rec: Recording, filePath: string, second: number): Promise<{
    entry: SeekEntry;
    startSecond: number;
    seqs: SeekEntry[];
  }> {
    const { entries, seqs } = await this.loadIndex(filePath);
    const info = seekIndexOf(filePath, existsSync(seekSidecarPath(filePath)));
    if (info.seekIndexState === 'building') {
      void this.startScan(filePath, rec.id);
      throw new AppError('RECORDING_START_FAILED', '正在建立定位索引，请稍后再试', {
        retryable: true,
        details: { recordingId: rec.id, seekIndexProgress: info.seekIndexProgress ?? 0 },
      });
    }
    if (entries.length === 0) {
      // 在录但索引缺失（写入降级/被清理）：后台重建，先明确告知不可用。
      void this.startScan(filePath, rec.id);
      throw new AppError('RECORDING_START_FAILED', '正在建立定位索引，请稍后再试', {
        retryable: true,
        details: { recordingId: rec.id },
      });
    }
    const targetMs = Math.max(0, Math.floor(second * 1000));
    const entry = lookupSeekEntry(entries, targetMs) ?? entries[0]!;
    const valid = await validateSeekEntry(filePath, entry);
    if (!valid) {
      this.invalidate(filePath);
      void this.startScan(filePath, rec.id);
      throw new AppError('RECORDING_START_FAILED', '定位索引已失效，正在重建，请稍后再试', {
        retryable: true,
        details: { recordingId: rec.id },
      });
    }
    return { entry, startSecond: entry.t / 1000, seqs };
  }

  /** 预热：零进程准备（读索引进缓存+校验目标点），松手才真正起流。幂等。
   *  返回吸附后的起播真值：起流对同一请求秒的吸附是确定性的（同一关键帧），
   *  前端用 startSecond+播放进度即可精确映射源时间轴（fMP4 输出时间轴会被 ffmpeg 归零）。 */
  async prewarm(rec: Recording, second: number): Promise<{ startSecond: number }> {
    const filePath = this.requireSeekable(rec);
    const { startSecond } = await this.resolveTarget(rec, filePath, second);
    return { startSecond };
  }

  /** 起流：返回 fMP4 流与实际起播秒（关键帧吸附，可能略早于请求秒）。 */
  async openStream(rec: Recording, second: number): Promise<{ stream: Readable; startSecond: number }> {
    const filePath = this.requireSeekable(rec);
    const { entry, startSecond, seqs } = await this.resolveTarget(rec, filePath, second);
    const tail = await fileSizeSnapshot(filePath);
    if (tail === null) {
      throw new AppError('RECORDING_NOT_AVAILABLE', '录像文件不可读', {
        details: { recordingId: rec.id },
      });
    }
    if (tail <= entry.b + 13) {
      throw new AppError('RECORDING_NOT_AVAILABLE', '该位置暂无可播放内容', {
        retryable: true,
        details: { recordingId: rec.id },
      });
    }

    // 同点复用：同秒在途会话直接挂载（重放已缓冲段+续接），不重开进程。
    const existing = this.sessions.get(rec.id);
    if (existing && existing.second === second && !existing.overflow) {
      return { stream: this.attach(existing), startSecond: existing.startSecond };
    }
    if (existing) this.killSession(rec.id);
    if (this.sessions.size >= MAX_SEEK_SESSIONS) {
      throw new AppError('CONCURRENT_LIMIT_REACHED', '跳播并发已满，请稍后再试', {
        retryable: true,
        details: { recordingId: rec.id, limit: MAX_SEEK_SESSIONS },
      });
    }

    const prefix = await this.buildPrefix(filePath, entry, seqs);
    const proc = this.procFactory({ filePath, prefix, from: entry.b, to: tail });
    const session: SeekSession = {
      recordingId: rec.id,
      second,
      startSecond,
      proc,
      replay: [],
      replayBytes: 0,
      overflow: false,
      subscribers: new Set(),
    };
    this.sessions.set(rec.id, session);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (session.replayBytes + chunk.length <= REPLAY_CAP_BYTES) {
        session.replay.push(chunk);
        session.replayBytes += chunk.length;
      } else {
        session.overflow = true;
      }
      for (const sub of session.subscribers) {
        sub.write(chunk);
      }
    });
    proc.stdout.on('error', () => undefined);
    void proc.done.then(() => {
      for (const sub of session.subscribers) sub.end();
      session.subscribers.clear();
      if (this.sessions.get(rec.id) === session) this.sessions.delete(rec.id);
    });
    return { stream: this.attach(session), startSecond };
  }

  private attach(session: SeekSession): Readable {
    const sink = new PassThrough();
    for (const buf of session.replay) sink.write(buf);
    session.subscribers.add(sink);
    sink.on('close', () => session.subscribers.delete(sink));
    return sink;
  }

  private async buildPrefix(filePath: string, entry: SeekEntry, seqs: SeekEntry[]): Promise<Buffer> {
    const parts: Buffer[] = [];
    const handle = await import('node:fs/promises').then((m) => m.open(filePath, 'r'));
    try {
      const head = Buffer.alloc(13);
      const { bytesRead } = await handle.read(head, 0, 13, 0);
      if (bytesRead < 13 || head.subarray(0, 3).toString('ascii') !== 'FLV') {
        throw new AppError('RECORDING_NOT_AVAILABLE', '录像文件不可读', {});
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
    this.sessions.delete(recordingId);
    session.proc.kill();
    for (const sub of session.subscribers) sub.end();
    session.subscribers.clear();
  }

  /**
   * 启动补扫：把「功能上线/重启前写入的前缀」补进索引（后台顺序读、让位写盘）。
   * 建好前跳播显式不可用，建好自动恢复。
   */
  async startupScan(): Promise<number> {
    let count = 0;
    for (const state of ['recording', 'reconnecting'] as const) {
      const rows = this.services.recordings.list({ page: 1, pageSize: 100, state }).items;
      for (const rec of rows) {
        if (!rec.filePath || !rec.filePath.endsWith('.flv')) continue;
        const info = seekIndexOf(rec.filePath, existsSync(seekSidecarPath(rec.filePath)));
        if (info.seekIndexState === 'ready') continue;
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
    beginSeekScan(filePath, 0, size);
    this.invalidate(filePath);
    this.emitSeekState(recId);
    let lastEmit = 0;
    // 扫描期持有 writer 批量追加；不登记覆盖（扫描不是写入段）。
    const writer = await SeekIndexWriter.open(filePath, 0, { trackCoverage: false });
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
    } catch {
      finishSeekScan(filePath, false);
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
        type: 'recording:updated',
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
  }
}
