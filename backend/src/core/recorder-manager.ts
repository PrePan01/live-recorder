import { createWriteStream, statSync, type WriteStream } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { AppError } from "../types/error.js";
import type {
  AppSettings,
  ErrorObject,
  RecordingEndReason,
  Room,
} from "../types/index.js";
import {
  fileCreateError,
  causeLabel,
  failureText,
  humanizeFailure,
  reconnectExhausted,
  isWriteFailure,
  withReasonCategory,
  writeFailure,
  writeRestartExhausted,
} from "./recording-failure.js";
import {
  recordingFilePath,
  sanitizeRenameBase,
  uniqueTargetPath,
} from "../storage/file-organizer.js";
import {
  moveMarkerSidecar,
  removeMarkerSidecar,
  promoteMarkerSidecar,
} from "../storage/recording-markers.js";
import {
  moveSeekIndexSidecar,
  removeSeekIndexSidecar,
} from "../storage/seek-index.js";
import { checkFileIntegrity } from "../recorder/integrity.js";
import type { RecordingEvent } from "../recorder/engine.js";
import {
  FlvTimestampNormalizer,
  type FlvTagInfo,
} from "../recorder/stream-recorder.js";
import { SeekIndexWriter, endSeekWriter } from "../storage/seek-index.js";
import { HighlightBuffer } from "../recorder/highlight-buffer.js";
import { exportClipFile } from "../recorder/pipeline-ffmpeg.js";
import type { Notifier } from "./notifier.js";
import type { Services } from "./services.js";
import {
  PerformanceDiagnostics,
  type PerformanceTrace,
} from "./performance-diagnostics.js";

export interface PreviewSink {
  canAccept(): boolean;
  /** 是否仍有客户端观看；共享录制结束后据此决定是否保留预览拉流。 */
  hasClients(roomId: string): boolean;
  broadcastFrame(roomId: string, chunk: Buffer): void;
  closeRoom(
    roomId: string,
    code: number,
    reason?: "ended" | "stream_lost",
  ): void;
  /** 新录制/新分段开始时清空该房间预览头缓冲，确保下一段流的 FLV 头被重新捕获。 */
  resetRoom(roomId: string): void;
  /** 获取可从关键帧开始写入录制文件的预览数据，不中断已连接的预览客户端。 */
  recordingBootstrap?(roomId: string): Buffer | null;
}

/** 录制完成询问是否保留待确认超时。 */
export const KEEP_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
/** 精彩时刻导出持续有 I/O 进度就允许继续；仅持续无进度才判定卡死。 */
export const HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const HIGHLIGHT_EXPORT_WATCHDOG_REFRESH_MS = 1_000;
/** 录像待写上限大小 */
const MAX_SHARED_RECORDING_PENDING_BYTES = 32 * 1024 * 1024;
/** 写积压触顶后、判定「真死」前的持续等待宽限 */
const SHARED_WRITER_SLOW_GRACE_MS = 180_000;

/**
 * 失败自动恢复录制尝试次数
 */
const WRITE_RESTART_ATTEMPTS = 3;
/** 开录后多久还没写出文件即视为拿不到数据 */
const START_TIMEOUT_MS = 30_000;
/** 复用前体检阈值：预览上游静默超过此时长即判陈旧、拆旧回退现解析。 */
const PREVIEW_FRESHNESS_MS = 30_000;
/** 录制中停流检测窗：静默超此值立即触发断流重连（6s≈2~3 个 GOP，历史断流恢复节奏全落窗内）。 */
const RECORDING_STALL_MS = 6_000;
/** 缺口记账条目门槛：短抖动只留日志不刷历史条目；缺失时长照旧累计一秒不丢。 */
export const GAP_ROW_MIN_MS = 30_000;
/** 取流失败持续告警阈值：超过此时长仍重连中即发人话告警（持续重试不停录）。 */
export const RECONNECT_ALERT_AFTER_MS = 5 * 60_000;
/** 断流重连快速退避链（秒）：判定即首试零等待，其后 1-2-5-10-30 封顶——宁可误判几次也不干等丢内容。 */
export const RECONNECT_CHAIN_SEC = [0, 1, 2, 5, 10, 30];

/**
 * 涓流判据：只有媒体时间戳推进才算「活着」。冻结 TS 的涓流字节会喂饱字节判据
 * 但内容不长（空录制死法），故看门狗按时间戳复位、不按字节复位。
 * 无录制（纯预览，ts=-1）时按字节活跃处理。
 */
export function mediaAliveSince(prevTs: number, tsNow: number): boolean {
  return tsNow < 0 || tsNow > prevTs;
}
/** Preview has no recording-level start watchdog; recycle a source that never yields its first byte. */
const PREVIEW_START_TIMEOUT_MS = 10_000;
/** 恢复后稳定录满这么久，就归还重连额度——几小时前的旧故障不该拖累现在这一次抖动。 */
const STABLE_RESET_MS = 60_000;
/** 续录前旧流收尾上限 */
const PULL_STOP_GRACE_MS = 3_000;
/** 退出前等写流落盘的上限 */
const SHUTDOWN_GRACE_MS = 3_000;
/** 收尾时最后一份数据到现在超时时长 */
const TAIL_SILENCE_MIN_MS = 5_000;

/** 同时进行的片段导出全局上限：防用户连点造成同文件多路读/CPU 风暴（正常并行不受影响）。 */
const MAX_PARALLEL_CLIP_EXPORTS = 6;

/** 落盘改名临界区：并行导出同名收尾时防「查重→改名」间隙互撞（进程内串行即可）。 */
let clipFinalizeChain: Promise<unknown> = Promise.resolve();
function withClipFinalizeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = clipFinalizeChain.then(fn, fn);
  clipFinalizeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 收尾时仍未结算的静默时长（毫秒）。录制期间累计缺失只在"恢复拿到数据"时才结算，
 */
function tailSilenceMs(
  session: ActiveSession | undefined,
  now: number,
): number {
  if (!session) return 0;
  const silent = now - session.lastDataAt;
  return silent >= TAIL_SILENCE_MIN_MS ? silent : 0;
}

/**
 * 片段命名校验：必填 1-120 字、文件名非法字符直接拒绝（用户重输），
 * 兼容误带的视频扩展名（与历史改名同口径去掉后缀）。
 */
function validateClipName(raw: string, recordingId: string): string {
  const base = (typeof raw === "string" ? raw : "")
    .trim()
    .replace(/\.(?:flv|mp4|mkv|ts|webm)$/i, "")
    .trim();
  if (!base || base.length > 120) {
    throw new AppError("CONFIG_INVALID", "片段名称需为 1-120 个字符", {
      recordingId,
    });
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) {
    throw new AppError(
      "CONFIG_INVALID",
      '片段名称不能包含 \\ / : * ? " < > | 等字符',
      { recordingId },
    );
  }
  return base;
}

interface ActiveSession {
  recordingId: string;
  roomId: string;
  streamSessionId: string | null;
  stopRequested: boolean;
  wakeReconnect?: () => void;
  reconnectSince?: number;
  recoveringAlerted?: boolean;
  requestedEndReason?: RecordingEndReason;
  size: number;
  startedAt: string;
  /** 当前分段实际使用的引擎；停止时必须作用于这个实例。 */
  engine: import("../recorder/engine.js").RecordingEngine | null;
  /** 本次录制的文件：中断恢复后接着写它，不再新开文件。 */
  filePath: string | null;
  /** 已写出的分段数；>0 表示本次拉流要追加写入而不是新建。 */
  segments: number;
  /** 续录时间偏移：本段媒体时间戳接在上一段结尾之后，保证拼接处播放连续。 */
  timestampOffsetMs: number;
  /** 最后一次收到数据的时刻；中断造成的缺失时长从它算起。 */
  lastDataAt: number;
  /** 中断开始时刻；恢复拿到第一份数据时据此累计缺失时长，非中断期间为 null。 */
  gapStartAt: number | null;
  /** 累计缺失时长（毫秒）。 */
  missingMs: number;
  /** 写盘失败自动恢复已用次数（PrePan 钦定共 3 次；稳定录满 STABLE_RESET_MS 归还）。 */
  writeRestartCount: number;
  /** 写盘自动恢复尝试进行中：手动开录（产品边界）据此让位。 */
  writeRestartPending: boolean;
  /** 用户手动介入后置位：恢复循环逐次检查，立即停止自动重启。 */
  writeRestartCancelled: boolean;
  /** 自动恢复流程收口信号：手动开录等它结束再接管，避免两路抢同一房间。 */
  writeRestartDone?: Promise<void> | undefined;
  /** 最近一次恢复录制的时刻；用于重连额度按轮重置。 */
  lastRecoveryAt: number;
  /** 拉流会话代次：被取代的旧会话据此停止处理事件，避免两路拉流同时写同一个文件。 */
  generation: number;
  /** 当前这一路拉流的完成信号（含关闭写流）；续录前必须等它，否则新旧两个写流会同时写同一个文件。 */
  pullDone: Promise<void> | null;
  /** 接力互斥：超时/断流/自然结束可能同时触发，只允许一次接力在途。 */
  handingOff: boolean;
  /** 手动停止接口等待录制记录和房间状态真正收口，避免响应先于异步生成器退出。 */
  done?: Promise<void>;
  resolveDone?: () => void;
  startupTrace?: PerformanceTrace;
}

interface PreviewSession {
  engine: import("../recorder/engine.js").RecordingEngine;
  /** The actual quality of this already-open upstream stream. */
  actualQuality: string;
  /** First upstream data arrived; a socket alone is not enough to trust a preview as live. */
  hasReceivedData: boolean;
  /** 最近一次上游数据时刻：复用体检与停流判据的事实源（缺此字段=只认首包、不认新鲜度）。 */
  lastDataAt: number;
  /** 停流看门狗命中：收束必须走断流重连（记缺失）而非自然结束——干涸不是播完。 */
  stalled: boolean;
  done: Promise<void>;
  recording: SharedPreviewRecording | null;
  /** 仅供没有可复用 bootstrap 时走旧交接路径。 */
  transitioningToRecording: boolean;
  startupTrace?: PerformanceTrace;
}

const writerErrorHooks = new WeakSet<object>();

export interface SharedPreviewRecording {
  session: ActiveSession;
  writer: WriteStream;
  normalizer: FlvTimestampNormalizer;
  /** 跳播定位索引写入器：共享预览支路与 runHttp 同样顺手记（否则预览转录制无索引）。 */
  seekWriter: SeekIndexWriter | null;
  pendingWrites: Buffer[];
  pendingWriteBytes: number;
  writePump: Promise<void> | null;
  writeError: Error | null;
  /** 首次积压触顶时刻（null=未降级）；排空恢复后清零，用于持续时长判定。 */
  degradedSince: number | null;
  /** 降级期间因无法入队而丢弃的字节数（磁盘恢复前本就写不进盘的部分）。 */
  droppedBytes: number;
}

export class RecorderManager {
  readonly performance: PerformanceDiagnostics;
  private active = new Map<string, ActiveSession>();
  /** 片段导出在途：`源录制id:起-止` → clip id（同选区防重复提交，不同选区可并行）。 */
  private clipExports = new Map<string, string>();
  /** clip id → 已推送的进度百分比（列表响应补「导出中 x%」用，终态清除）。 */
  private clipProgress = new Map<string, number>();
  /** 片段导出取消信号（删除联动：导出任务立即真停）。 */
  private clipExportAborts = new Map<string, AbortController>();
  /** Prevent manual and scheduler starts from both passing the async preflight. */
  private starting = new Set<string>();
  private backgroundTasks = 0;
  /** 正在退出：只等写流落盘，不再收尾/通知/跑后处理（状态交给下次启动的恢复流程）。 */
  private shuttingDown = false;

  get busy(): boolean {
    return this.active.size > 0 || this.backgroundTasks > 0;
  }

  async resetIdleState(): Promise<void> {
    await Promise.all(
      [...this.previewSessions.keys()].map((id) => this.stopPreviewStream(id)),
    );
    await Promise.all(
      [...this.highlightBuffers.keys()].map((id) =>
        this.disableHighlightBuffer(id),
      ),
    );
  }

  /**
   * 退出前收尾：停掉所有正在拉流的会话并等写流落盘关闭，避免最后几秒数据还没写进文件就退出了。
   * 这里刻意不写库、不发通知、不起后处理：进程马上消失，记录状态交给下次启动的恢复流程统一收口
   * （标记为"服务重启中断"，并重跑校验 / mp4_after 转封装 / 管线 / 上传）。
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending: Promise<void>[] = [];
    for (const session of [...this.active.values()]) {
      session.wakeReconnect?.();
      pending.push(
        session.engine?.stop().catch(() => undefined) ?? Promise.resolve(),
      );
      const pull = session.pullDone;
      // 等这一路拉流真正退出：写流在它的 finally 里 flush + close。
      if (pull) pending.push(pull.catch(() => undefined));
    }
    for (const preview of [...this.previewSessions.values()]) {
      pending.push(preview.engine.stop().catch(() => undefined));
      pending.push(preview.done.catch(() => undefined));
    }
    // 退出绝不能被某个不响应 stop() 的拉流卡住：到点即放手。
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
      }),
    ]);
  }

  /** 启动恢复用：把上次退出时中断、还没跑过收尾流程的录制重新交给收尾（校验 / 转封装 / 管线 / 上传）。 */
  resumeRecoveredProcessing(recordingId: string): void {
    this.finishSegmentProcessing(recordingId);
  }

  clearPendingConfirmations(): void {
    for (const id of this.confirmTimers.keys()) this.clearConfirmTimer(id);
  }
  preview: PreviewSink | null = null;

  /** 待确认保留的录制 → 超时自动保留定时器。 */
  private confirmTimers = new Map<string, unknown>();
  /** 正在转 MP4 的录制；分段收尾与录制完成可能各触发一次，必须避免两个 ffmpeg 抢同一份产物。 */
  /** Explicit normal-preview highlight caches. Live-wall clients never create these. */
  private highlightBuffers = new Map<string, HighlightBuffer>();
  /**
   * 精彩时刻导出期间提前展示的保留确认。导出可能需要等待当前缓存分段落盘，
   * 不能让这段 I/O 延迟阻塞确认框，也不能在文件尚未生成时启动后处理或删除记录。
   */
  private pendingHighlightConfirmations = new Map<
    string,
    { decision?: { keep: boolean; fileName?: string } }
  >();
  private highlightExportJobs = new Map<
    string,
    {
      controller: AbortController;
      timeout: unknown;
      settling: boolean;
      lastWatchdogRefreshAt: number | null;
      done: Promise<void>;
      resolveDone: () => void;
    }
  >();

  constructor(
    private services: Services,
    private notifier: Notifier,
  ) {
    this.performance = new PerformanceDiagnostics(services.clock);
  }

  settings(): AppSettings {
    const stored = this.services.settings.load();
    return stored ?? { ...structuredClone(defaultsLite()) };
  }

  isRoomActive(roomId: string): boolean {
    return this.active.has(roomId);
  }

  isRoomStarting(roomId: string): boolean {
    return this.starting.has(roomId);
  }

  /** 新建录制会话：续录/缺失时长相关的状态集中在这里初始化。 */
  private newSession(
    recordingId: string,
    roomId: string,
    streamSessionId: string | null,
    startedAt: string,
    filePath: string | null,
  ): ActiveSession {
    const now = this.services.clock.now();
    return {
      recordingId,
      roomId,
      streamSessionId,
      stopRequested: false,
      size: 0,
      startedAt,
      engine: null,
      filePath,
      segments: 0,
      timestampOffsetMs: 0,
      lastDataAt: now,
      gapStartAt: null,
      missingMs: 0,
      writeRestartCount: 0,
      writeRestartPending: false,
      writeRestartCancelled: false,
      lastRecoveryAt: now,
      generation: 0,
      pullDone: null,
      handingOff: false,
    };
  }

  activeRoomIds(): string[] {
    return [...this.active.keys()];
  }

  /** 当前录制会话信息（未录制返回 null），供监控总览显示录制时长。 */
  activeRecordingFor(roomId: string): Room["activeRecording"] {
    const session = this.active.get(roomId);
    return session
      ? { recordingId: session.recordingId, startedAt: session.startedAt }
      : null;
  }

  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(room: Room): Room {
    return { ...room, activeRecording: this.activeRecordingFor(room.id) };
  }

  /** 补发 service:status SSE，供前端顶部导航实时显示录制中数量。 */
  emitServiceStatus(): void {
    this.services.events.emit({
      type: "service:status",
      data: {
        state: "running",
        activeRecordings: this.active.size,
        setupCompleted: Boolean(
          this.services.settings.load()?.recordingDirectory?.length,
        ),
      },
    });
  }

  // ---- 预览专用拉流（#163：预览=纯观看，不触发录制、不落盘）----
  private previewSessions = new Map<string, PreviewSession>();
  private previewTransitions = new Set<string>();
  private previewStarts = new Map<string, Promise<void>>();
  private highlightCleanup = new Map<string, Promise<void>>();

  isPreviewStreaming(roomId: string): boolean {
    return this.previewSessions.has(roomId);
  }

  isPreviewReadyForRecording(roomId: string): boolean {
    const session = this.previewSessions.get(roomId);
    if (!session || session.recording || !session.hasReceivedData) return false;
    const bootstrap = this.preview?.recordingBootstrap?.(roomId);
    return Boolean(bootstrap && bootstrap.subarray(0, 3).toString() === "FLV");
  }

  async enableHighlightBuffer(roomId: string): Promise<{
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  }> {
    await this.highlightCleanup.get(roomId)?.catch(() => undefined);
    if (this.active.has(roomId))
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "实时录制中无需使用精彩时刻",
        { roomId },
      );
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== "live")
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "直播间未开播，无法启用精彩时刻",
        { roomId },
      );
    const settings = this.settings();
    if (settings.highlightEnabled === false)
      throw new AppError("RECORDING_NOT_AVAILABLE", "精彩时刻功能未开启", {
        roomId,
      });
    if (!settings.recordingDirectory)
      throw new AppError("DIRECTORY_NOT_WRITABLE", "请先配置录像保存目录", {
        roomId,
      });
    let buffer = this.highlightBuffers.get(roomId);
    if (buffer && !buffer.isAccepting) {
      await buffer.clear();
      this.highlightBuffers.delete(roomId);
      buffer = undefined;
    }
    if (!buffer) {
      const dir = path.join(
        settings.recordingDirectory,
        ".live-recorder-cache",
        roomId,
      );
      buffer = new HighlightBuffer(dir, settings.highlightBufferSeconds ?? 300);
      await buffer.start();
      this.highlightBuffers.set(roomId, buffer);
      // 共享预览流在停止录制后不会重新发送 FLV 文件头。用预览缓存的初始化段和
      // 关键帧播种精彩时刻缓存，否则新缓存会永远等待一个不会再出现的文件头。
      // 只接受 FLV 头起始的 bootstrap；拿不到时保持 awaitingHeader，
      // 由后续预览帧上的延迟播种（maybeSeedHighlightBuffer）兜底——首开时
      // mkdir 期间到达的首帧可能已错过，不能只播一次就放弃。
      this.seedHighlightBuffer(roomId, buffer);
    } else {
      buffer.setRetainSeconds(settings.highlightBufferSeconds ?? 300);
      this.seedHighlightBuffer(roomId, buffer);
    }
    return {
      availableSeconds: buffer.availableSeconds(),
      maxSeconds: settings.highlightBufferSeconds ?? 300,
      accepting: buffer.isAccepting,
      ...(buffer.backpressureReason
        ? { disabledReason: buffer.backpressureReason }
        : {}),
    };
  }

  /**
   * 用预览房的 FLV 初始化段播种精彩时刻缓存。仅当 bootstrap 以 FLV 开头才写入；
   * 失败时缓冲区保持 awaitingHeader，等预览帧路径延迟重试（首开竞态兜底）。
   * 取证（脱敏）：只记 roomId 后缀与 bootstrap 形态，不打内容。
   */
  private seedHighlightBuffer(
    roomId: string,
    buffer: HighlightBuffer,
  ): boolean {
    if (!buffer.awaitingHeader) return true;
    const bootstrap = this.preview?.recordingBootstrap?.(roomId);
    const flv = Boolean(
      bootstrap && bootstrap.subarray(0, 3).toString() === "FLV",
    );
    if (!flv) {
      // 首开常见：预览房尚未捕获头 → 保持 awaitingHeader，后续帧延迟播种。
      if (process.env.LIVE_RECORDER_DEBUG === "1")
        console.warn(
          `[highlight] seed miss room=…${roomId.slice(-6)} bootstrap=${bootstrap ? `len=${bootstrap.length}` : "null"}`,
        );
      return false;
    }
    buffer.append(bootstrap!);
    const ok = !buffer.awaitingHeader;
    if (!ok && process.env.LIVE_RECORDER_DEBUG === "1")
      console.warn(
        `[highlight] seed incomplete room=…${roomId.slice(-6)} len=${bootstrap!.length}`,
      );
    return ok;
  }

  /** 预览帧到达且缓冲区仍缺 FLV 头时延迟播种（A1/A3：首开丢头后恢复）。 */
  private maybeSeedHighlightBuffer(
    roomId: string,
  ): HighlightBuffer | undefined {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer?.awaitingHeader) return buffer;
    this.seedHighlightBuffer(roomId, buffer);
    return buffer;
  }

  async disableHighlightBuffer(roomId: string): Promise<void> {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer) return;
    this.highlightBuffers.delete(roomId);
    await buffer.clear();
  }

  private detachHighlightBufferForRecording(roomId: string): void {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer) return;
    this.highlightBuffers.delete(roomId);
    const cleanup = buffer.clear().catch(() => undefined);
    this.highlightCleanup.set(roomId, cleanup);
    void cleanup.finally(() => {
      if (this.highlightCleanup.get(roomId) === cleanup)
        this.highlightCleanup.delete(roomId);
    });
  }

  /** 清空内容但保留当前观看的缓存会话，后续预览帧会立即重新累计。 */
  async clearHighlightBuffer(roomId: string): Promise<void> {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer)
      throw new AppError("RECORDING_NOT_AVAILABLE", "精彩时刻缓存未启用", {
        roomId,
      });
    await buffer.reset();
  }

  async disableAllHighlightBuffers(): Promise<void> {
    await Promise.all(
      [...this.highlightBuffers.keys()].map((id) =>
        this.disableHighlightBuffer(id),
      ),
    );
  }

  highlightStatus(roomId: string): {
    enabled: boolean;
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  } {
    const buffer = this.highlightBuffers.get(roomId);
    return {
      enabled: Boolean(buffer),
      availableSeconds: buffer?.availableSeconds() ?? 0,
      maxSeconds: this.settings().highlightBufferSeconds ?? 300,
      accepting: buffer?.isAccepting ?? false,
      ...(buffer?.backpressureReason
        ? { disabledReason: buffer.backpressureReason }
        : {}),
    };
  }

  async exportHighlight(
    roomId: string,
    lookbackSeconds: number,
  ): Promise<{ recordingId: string; availableSeconds: number }> {
    if (this.active.has(roomId))
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "实时录制中无需使用精彩时刻",
        { roomId },
      );
    const room = this.services.rooms.get(roomId);
    const buffer = this.highlightBuffers.get(roomId);
    if (this.settings().highlightEnabled === false)
      throw new AppError("RECORDING_NOT_AVAILABLE", "精彩时刻功能未开启", {
        roomId,
      });
    if (!room || !buffer)
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "请先在普通观看窗口中等待精彩时刻缓存",
        { roomId },
      );
    const maxSeconds = this.settings().highlightBufferSeconds ?? 300;
    if (
      !Number.isInteger(lookbackSeconds) ||
      lookbackSeconds < 1 ||
      lookbackSeconds > maxSeconds
    )
      throw new AppError(
        "CONFIG_INVALID",
        `回溯时长需为 1 秒至 ${maxSeconds} 秒`,
        { roomId },
      );
    const availableSeconds = buffer.availableSeconds();
    if (availableSeconds < 1)
      throw new AppError("RECORDING_NOT_AVAILABLE", "精彩时刻缓存尚未就绪", {
        roomId,
      });
    if (lookbackSeconds > availableSeconds) {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        `精彩时刻缓存仅有 ${availableSeconds} 秒，请稍后再试`,
        { roomId },
      );
    }
    const settings = this.settings();
    const recording = this.services.recordings.create({
      roomId,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: null,
      streamTitle: `精彩时刻｜${room.displayName}`,
      quality: settings.quality,
      expectedQuality: settings.quality,
      origin: "highlight",
    });
    const base = recordingFilePath(
      settings.recordingDirectory,
      room.platform,
      room.displayName || room.id,
      recording.startedAt,
      settings.recordingFormat,
      settings.namingRule,
      settings.quality,
      room.id,
    );
    const parsed = path.parse(base);
    const filePath = path.join(
      parsed.dir,
      `${parsed.name}_highlight_${recording.id}${parsed.ext}`,
    );
    const confirmAfterComplete = this.settings().confirmAfterComplete;
    if (confirmAfterComplete) {
      this.pendingHighlightConfirmations.set(recording.id, {});
      this.services.recordings.update(recording.id, {
        filePath,
        highlightExportPending: true,
        highlightConfirmationDecision: null,
        highlightConfirmationFileName: null,
      });
      this.enterPendingConfirmation(recording.id);
    }
    const controller = new AbortController();
    let resolveDone!: () => void;
    const job = {
      controller,
      timeout: undefined as unknown,
      settling: false,
      lastWatchdogRefreshAt: null,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone,
    };
    this.highlightExportJobs.set(recording.id, job);
    this.refreshHighlightExportWatchdog(recording.id, job, roomId, filePath);
    void (async () => {
      try {
        const result = await buffer.exportTo(
          filePath,
          lookbackSeconds,
          controller.signal,
          () =>
            this.refreshHighlightExportWatchdog(
              recording.id,
              job,
              roomId,
              filePath,
            ),
        );
        if (this.highlightExportJobs.get(recording.id) !== job) return;
        const endedAt = this.services.clock.iso();
        const startedAt = new Date(
          new Date(endedAt).getTime() - result.actualSeconds * 1_000,
        ).toISOString();
        const pending = this.pendingHighlightConfirmations.get(recording.id);
        const decision = pending?.decision;
        const completed = this.services.recordings.update(recording.id, {
          state: confirmAfterComplete ? "awaiting_confirmation" : "completed",
          filePath,
          fileSizeBytes: result.bytes,
          startedAt,
          endedAt,
          highlightExportPending: false,
          ...(decision
            ? {}
            : {
                highlightConfirmationDecision: null,
                highlightConfirmationFileName: null,
              }),
        });
        if (!confirmAfterComplete)
          this.services.events.emit({
            type: "recording:updated",
            data: completed,
          });
        if (!confirmAfterComplete) {
          this.finishOrConfirm(recording.id);
          return;
        }
        this.pendingHighlightConfirmations.delete(recording.id);
        if (!decision) {
          this.services.events.emit({
            type: "recording:updated",
            data: completed,
          });
          this.finishHighlightExportJob(recording.id, job);
          return;
        }
        if (decision.keep) {
          await this.renameConfirmedHighlight(recording.id, decision.fileName);
          this.resumeAfterConfirmation(recording.id);
        } else {
          this.discardAfterConfirmation(recording.id);
        }
        this.finishHighlightExportJob(recording.id, job);
      } catch (error) {
        if (
          this.highlightExportJobs.get(recording.id) === job &&
          !job.settling
        ) {
          job.settling = true;
          await this.failHighlightExport(recording.id, roomId, filePath, error);
        }
      } finally {
        job.resolveDone();
      }
    })();
    if (!confirmAfterComplete)
      this.services.events.emit({ type: "recording:updated", data: recording });
    return { recordingId: recording.id, availableSeconds };
  }

  /**
   * 若精彩时刻还在导出，将用户决定暂存到导出完成；返回 true 表示已接管。
   */
  deferHighlightConfirmation(
    recordingId: string,
    keep: boolean,
    fileName?: string,
  ): boolean {
    const pending = this.pendingHighlightConfirmations.get(recordingId);
    if (!pending) return false;
    this.clearConfirmTimer(recordingId);
    pending.decision = { keep, ...(fileName ? { fileName } : {}) };
    const updated = this.services.recordings.update(recordingId, {
      highlightConfirmationDecision: keep,
      highlightConfirmationFileName: fileName ?? null,
    });
    this.services.events.emit({ type: "recording:updated", data: updated });
    return true;
  }

  /** 通用删除路径也必须中止正在导出的精彩时刻，避免迟到的异步任务重建已删除记录。 */
  async cancelHighlightExport(recordingId: string): Promise<boolean> {
    const job = this.highlightExportJobs.get(recordingId);
    if (!job) return false;
    job.settling = true;
    job.controller.abort(new Error("精彩时刻导出已取消"));
    this.pendingHighlightConfirmations.delete(recordingId);
    this.clearConfirmTimer(recordingId);
    // 等输出/输入流关闭后才允许调用方 unlink；Windows 上打开的句柄会拒绝删除。
    await job.done;
    this.finishHighlightExportJob(recordingId, job);
    return true;
  }

  private finishHighlightExportJob(
    recordingId: string,
    job: {
      controller: AbortController;
      timeout: unknown;
      settling: boolean;
      lastWatchdogRefreshAt: number | null;
      done: Promise<void>;
      resolveDone: () => void;
    },
  ): void {
    if (this.highlightExportJobs.get(recordingId) !== job) return;
    this.services.clock.clearTimeout(job.timeout);
    this.highlightExportJobs.delete(recordingId);
  }

  private refreshHighlightExportWatchdog(
    recordingId: string,
    job: {
      controller: AbortController;
      timeout: unknown;
      settling: boolean;
      lastWatchdogRefreshAt: number | null;
      done: Promise<void>;
      resolveDone: () => void;
    },
    roomId: string,
    filePath: string,
  ): void {
    if (this.highlightExportJobs.get(recordingId) !== job || job.settling)
      return;
    const now = this.services.clock.now();
    if (
      job.lastWatchdogRefreshAt !== null &&
      now - job.lastWatchdogRefreshAt < HIGHLIGHT_EXPORT_WATCHDOG_REFRESH_MS
    )
      return;
    this.services.clock.clearTimeout(job.timeout);
    job.lastWatchdogRefreshAt = now;
    job.timeout = this.services.clock.setTimeout(() => {
      if (this.highlightExportJobs.get(recordingId) !== job || job.settling)
        return;
      job.settling = true;
      job.controller.abort(new Error("精彩时刻导出无进度超时"));
      void this.failHighlightExport(
        recordingId,
        roomId,
        filePath,
        new Error("精彩时刻导出连续 2 分钟无磁盘 I/O 进度"),
      );
    }, HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS);
  }

  private async failHighlightExport(
    recordingId: string,
    roomId: string,
    filePath: string,
    error: unknown,
  ): Promise<void> {
    const job = this.highlightExportJobs.get(recordingId);
    if (job) job.settling = true;
    try {
      this.clearConfirmTimer(recordingId);
      const pending = this.pendingHighlightConfirmations.get(recordingId);
      this.pendingHighlightConfirmations.delete(recordingId);
      const rec = this.services.recordings.get(recordingId);
      const decision =
        pending?.decision?.keep ?? rec?.highlightConfirmationDecision;
      // 不完整的 FLV 不能作为已保存录像留下；用户明确选择不保留时也应兑现决定。
      await unlink(filePath).catch(() => undefined);
      if (decision === false) {
        this.services.recordings.remove(recordingId);
        this.services.events.emit({
          type: "recording:deleted",
          data: { id: recordingId },
        });
        return;
      }
      const err = new AppError(
        "HIGHLIGHT_EXPORT_FAILED",
        failureText("HIGHLIGHT_EXPORT_FAILED"),
        {
          roomId,
          recordingId,
          details: { cause: (error as Error).message },
        },
      );
      const failed = this.services.recordings.update(recordingId, {
        state: "failed",
        endedAt: this.services.clock.iso(),
        filePath: null,
        fileSizeBytes: 0,
        highlightExportPending: false,
        highlightConfirmationDecision: null,
        highlightConfirmationFileName: null,
        failureReason: err.toObject(),
      });
      this.services.events.emit({ type: "recording:updated", data: failed });
    } finally {
      if (job) this.finishHighlightExportJob(recordingId, job);
    }
  }

  private async renameConfirmedHighlight(
    recordingId: string,
    fileName: string | undefined,
  ): Promise<void> {
    if (!fileName) return;
    const rec = this.services.recordings.get(recordingId);
    if (!rec?.filePath) return;
    const requested = path.basename(fileName.trim());
    const base = requested.replace(/\.(?:flv|mp4|mkv|ts|webm)$/i, "");
    const safeBase =
      base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "recording";
    const ext = path.extname(rec.filePath);
    const nextPath = path.join(path.dirname(rec.filePath), `${safeBase}${ext}`);
    try {
      const targetTaken = await access(nextPath)
        .then(() => true)
        .catch(() => false);
      if (targetTaken) {
        this.services.recordings.update(recordingId, {
          streamTitle: base.trim(),
        });
        return;
      }
      await rename(rec.filePath, nextPath);
      await moveMarkerSidecar(rec.filePath, nextPath);
      await moveSeekIndexSidecar(rec.filePath, nextPath);
      // 确认改名即保留：标签数据归位到 标签/（改名已完成、用新名落位）。
      await promoteMarkerSidecar(nextPath);
      this.services.recordings.update(recordingId, {
        streamTitle: base.trim(),
        filePath: nextPath,
      });
    } catch {
      // 改名失败不应阻断用户已确认的保留和后处理。
      this.services.recordings.update(recordingId, {
        streamTitle: base.trim(),
      });
    }
  }

  async ensurePreviewStream(roomId: string): Promise<void> {
    const existing = this.previewStarts.get(roomId);
    if (existing) return existing;
    const start = this.ensurePreviewStreamInner(roomId);
    this.previewStarts.set(roomId, start);
    try {
      await start;
    } finally {
      if (this.previewStarts.get(roomId) === start)
        this.previewStarts.delete(roomId);
    }
  }

  private async ensurePreviewStreamInner(roomId: string): Promise<void> {
    if (this.services.resetting) return;
    if (
      this.previewSessions.has(roomId) ||
      this.previewTransitions.has(roomId) ||
      this.active.has(roomId)
    )
      return;
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== "live") return;
    const startupTrace = this.performance.begin("preview_start", room);
    try {
      const settings = this.settings();
      const cookie = await this.services.platformCookie(room.platform);
      startupTrace.mark("platform_cookie_ready");
      const stream = await this.services
        .adapterFor(room.platform)
        .getStreamUrl(room.url, settings.quality, cookie);
      startupTrace.mark("stream_url_ready");
      // getStreamUrl 期间可能已经点击了录制；二次检查避免迟到的 preview-only 流覆盖录制流。
      if (
        this.services.resetting ||
        !this.services.rooms.get(roomId) ||
        this.previewSessions.has(roomId) ||
        this.previewTransitions.has(roomId) ||
        this.active.has(roomId)
      ) {
        startupTrace.finish("skipped");
        return;
      }
      const engine = this.services.engineFor();
      const session: PreviewSession = {
        engine,
        actualQuality: stream.actualQuality,
        hasReceivedData: false,
        lastDataAt: this.services.clock.now(),
        stalled: false,
        done: Promise.resolve(),
        recording: null,
        transitioningToRecording: false,
        startupTrace,
      };
      this.previewSessions.set(roomId, session);
      session.done = (async () => {
        let streamError: ErrorObject | null = null;
        let gotData = false;
        let startupTimedOut = false;
        let stallTimer: unknown = null;
        const startupTimer = this.services.clock.setTimeout(() => {
          if (gotData) return;
          startupTimedOut = true;
          void engine.stop().catch(() => undefined);
        }, PREVIEW_START_TIMEOUT_MS);
        try {
          const input = {
            url: stream.url,
            format: stream.format,
            ...(stream.headers ? { headers: stream.headers } : {}),
          };
          // 停流看门狗：上游静默超阈即停引擎，收束走断流重连换新流并记缺失。
          // 坑点：涓流字节也会刷新 lastDataAt，静默判据必须看「数据时刻」而非连接状态。
          // 坑点：看门狗必须收到首包后才启用——启动期归原 10 秒启动超时管，
          // 提前计时会把首包耗时 6~10 秒的正常请求误停。
          const armStallWatchdog = () => {
            clearTimeout2(this.services, stallTimer);
            stallTimer = this.services.clock.setTimeout(() => {
              session.stalled = true;
              void session.engine.stop().catch(() => undefined);
            }, RECORDING_STALL_MS);
          };
          // 涓流反制：只有媒体时间戳推进才算「活着」——冻结 TS 的涓流字节会喂饱字节判据
          // 但内容不长（正是空录制死法），故看门狗按时间戳复位、不按字节复位。
          // 坑点：基准必须随录制实例切换重置——新录制时间戳从 0 重排，沿用旧基准会永不复位误断流。
          let tsBaseOwner: unknown = null;
          let lastSeenTs = -1;
          for await (const event of engine.start(input, null)) {
            if (event.type === "data") {
              session.lastDataAt = this.services.clock.now();
              const owner = session.recording ?? null;
              const ownerChanged = owner !== tsBaseOwner;
              if (ownerChanged) {
                tsBaseOwner = owner;
                lastSeenTs = owner?.normalizer.lastTimestampMs ?? -1;
              }
              if (!gotData) {
                gotData = true;
                session.hasReceivedData = true;
                session.startupTrace?.finish("ok");
              }
              const sharedRecording = session.recording;
              if (sharedRecording) {
                try {
                  await this.appendSharedPreviewRecording(
                    sharedRecording,
                    event.chunk,
                  );
                } catch (error) {
                  session.recording = null;
                  sharedRecording.writer.destroy();
                  this.abandonSeekIndex(sharedRecording);
                  // 写盘失败不停死录制（PrePan 需求①）：转交写盘恢复策略（退避限次
                  // 自动重启新段、每场封顶、终停带明确原因）。预览帧循环不能被退避
                  // 等待阻塞，这里不等待恢复完成；后续帧已因 session.recording=null 不再写盘。
                  void this.handleDisconnect(
                    room,
                    sharedRecording.session.recordingId,
                    writeFailure(error, {
                      roomId,
                      recordingId: sharedRecording.session.recordingId,
                    }).toObject(),
                    0,
                    sharedRecording.session.timestampOffsetMs,
                  ).catch(() => undefined);
                }
              }
              // Parse this chunk before checking progress; a fresh frame must reset the timer now.
              const tsNow = session.recording?.normalizer.lastTimestampMs ?? -1;
              if (mediaAliveSince(lastSeenTs, tsNow) || ownerChanged) {
                armStallWatchdog();
              }
              if (tsNow > lastSeenTs) lastSeenTs = tsNow;
              if (this.settings().highlightEnabled !== false) {
                // 首开竞态：mkdir 期间首帧可能已丢、enable 时 bootstrap 也可能尚不可用。
                // 当前块不是 FLV 头时先从预览房延迟播种（此前帧已在 broadcastFrame 留底），
                // 再 append 当前块——避免错过唯一一次文件头后永久停在 0 秒。
                const highlight = this.highlightBuffers.get(roomId);
                if (highlight?.awaitingHeader) {
                  const startsFlv =
                    event.chunk.length >= 3 &&
                    event.chunk.subarray(0, 3).toString() === "FLV";
                  if (!startsFlv) {
                    const seeded = this.maybeSeedHighlightBuffer(roomId);
                    if (
                      seeded &&
                      !seeded.awaitingHeader &&
                      process.env.LIVE_RECORDER_DEBUG === "1"
                    )
                      console.warn(
                        `[highlight] late seed ok room=…${roomId.slice(-6)}`,
                      );
                  }
                }
                this.highlightBuffers.get(roomId)?.append(event.chunk);
              }
              this.preview?.broadcastFrame(roomId, event.chunk);
            }
            if (event.type === "error") {
              streamError = event.error;
              if (!gotData)
                session.startupTrace?.finish("failed", event.error.code);
              break;
            }
          }
        } catch (err) {
          streamError =
            err instanceof AppError
              ? err.toObject()
              : (streamError ??
                new AppError("NETWORK_UNAVAILABLE", "预览拉流中断", {
                  roomId,
                  retryable: true,
                }).toObject());
          if (!gotData)
            session.startupTrace?.finish("failed", streamError.code);
        } finally {
          clearTimeout2(this.services, stallTimer);
          clearTimeout2(this.services, startupTimer);
          if (startupTimedOut && !gotData)
            session.startupTrace?.finish("failed", "PREVIEW_START_TIMEOUT");
          if (!gotData && !streamError)
            session.startupTrace?.finish("failed", "STREAM_ENDED_BEFORE_DATA");
          if (this.previewSessions.get(roomId) === session)
            this.previewSessions.delete(roomId);
          let sharedRecording = session.recording;
          let handedOver = false;
          if (sharedRecording) {
            session.recording = null;
            let flushed = true;
            try {
              await this.closeSharedPreviewRecording(sharedRecording);
            } catch (error) {
              flushed = false;
              sharedRecording.writer.destroy();
              this.abandonSeekIndex(sharedRecording);
              // 收尾冲刷写盘失败：同样交写盘恢复策略（重拉续录新段，耗尽才终停）。
              // 此处预览上游流已结束，不会阻塞帧循环，可等待恢复流程启动。
              await this.handleDisconnect(
                room,
                sharedRecording.session.recordingId,
                writeFailure(error, {
                  roomId,
                  recordingId: sharedRecording.session.recordingId,
                }).toObject(),
                0,
                sharedRecording.session.timestampOffsetMs,
              );
            }
            if (flushed && !this.shuttingDown) {
              handedOver = true;
              const activeSession = sharedRecording.session;
              activeSession.segments = Math.max(1, activeSession.segments);
              activeSession.timestampOffsetMs = Math.max(
                activeSession.timestampOffsetMs,
                sharedRecording.normalizer.lastTimestampMs,
              );
              if (streamError || session.stalled) {
                await this.handleDisconnect(
                  room,
                  activeSession.recordingId,
                  streamError ??
                    new AppError(
                      "NETWORK_UNAVAILABLE",
                      "上游数据中断（静默超时）",
                      {
                        roomId,
                        retryable: true,
                      },
                    ).toObject(),
                  0,
                  activeSession.timestampOffsetMs,
                );
              } else {
                await this.handleNaturalEnd(
                  room,
                  activeSession.recordingId,
                  activeSession.size,
                  activeSession,
                  0,
                  activeSession.timestampOffsetMs,
                );
              }
            }
          }
          if (!handedOver) {
            this.preview?.closeRoom(
              roomId,
              session.transitioningToRecording ? 1012 : 4004,
              session.transitioningToRecording ? undefined : "stream_lost",
            );
          }
        }
      })();
    } catch (error) {
      startupTrace.finish(
        "failed",
        error instanceof AppError ? error.code : "PREVIEW_START_FAILED",
      );
      // 取流失败：不阻塞，前端按无帧处理
    }
  }

  /** 停止预览专用拉流（最后一个预览客户端断开时调用）。 */
  async stopPreviewStream(
    roomId: string,
    transitioningToRecording = false,
  ): Promise<void> {
    const session = this.previewSessions.get(roomId);
    if (!session) return;
    if (session.recording && !transitioningToRecording) return;
    if (transitioningToRecording) session.transitioningToRecording = true;
    await session.engine.stop().catch(() => undefined);
    await session.done.catch(() => undefined);
  }

  private appendSharedPreviewRecording(
    recording: SharedPreviewRecording,
    chunk: Buffer,
  ): void {
    if (recording.writeError) throw recording.writeError;
    const enqueueNow = this.services.clock.now();
    for (const part of recording.normalizer.push(Buffer.from(chunk))) {
      if (
        recording.pendingWriteBytes + part.length >
        MAX_SHARED_RECORDING_PENDING_BYTES
      ) {
        if (
          recording.degradedSince !== null &&
          enqueueNow - recording.degradedSince > SHARED_WRITER_SLOW_GRACE_MS
        ) {
          throw new Error("录制磁盘写入过慢");
        }
        if (recording.degradedSince === null) {
          recording.degradedSince = enqueueNow;
          console.warn(
            `[write-degraded] ${recording.session.recordingId} 写积压触顶(32MB)，进入等待恢复：丢弃新到块、录制不中断`,
          );
        }
        recording.droppedBytes += part.length;
        continue;
      }
      recording.session.size += part.length;
      recording.pendingWrites.push(part);
      recording.pendingWriteBytes += part.length;
    }
    // 排空过半=瞬时繁忙结束（USB 唤醒/同盘抢 IO 结束）：清降级起点重新计时。
    if (
      recording.degradedSince !== null &&
      recording.pendingWriteBytes <= MAX_SHARED_RECORDING_PENDING_BYTES / 2
    ) {
      console.warn(
        `[write-degraded] ${recording.session.recordingId} 写入恢复排空，降级解除（累计丢弃 ${recording.droppedBytes} 字节）`,
      );
      recording.degradedSince = null;
    }
    // 共享录制也要记"最后一份数据的时间"：否则中断/收尾时无法判断静默了多久，
    // 缺失时长会被算成整段录制时长（或干脆算不出来）。
    recording.session.lastDataAt = this.services.clock.now();
    this.startSharedWritePump(recording);
  }

  private startSharedWritePump(recording: SharedPreviewRecording): void {
    if (recording.writePump || recording.writeError) return;
    recording.writePump = (async () => {
      while (recording.pendingWrites.length > 0) {
        const part = recording.pendingWrites.shift()!;
        if (!recording.writer.write(part))
          await once(recording.writer, "drain");
        recording.pendingWriteBytes -= part.length;
      }
    })()
      .catch((error) => {
        recording.writeError =
          error instanceof Error ? error : new Error("录制文件写入失败");
      })
      .finally(() => {
        recording.writePump = null;
        if (recording.pendingWrites.length > 0 && !recording.writeError) {
          this.startSharedWritePump(recording);
        }
      });
  }

  private async closeSharedPreviewRecording(
    recording: SharedPreviewRecording,
  ): Promise<void> {
    if (recording.writeError) throw recording.writeError;
    const remaining = recording.normalizer.remaining();
    if (remaining.length > 0) {
      if (
        recording.pendingWriteBytes + remaining.length >
        MAX_SHARED_RECORDING_PENDING_BYTES
      ) {
        // 收尾冲刷不杀：余量是归一器最后的分片（有界小量），超帽也入队排出，绝不
        // 在此抛错——否则录完反而丢尾（QA 复测口径③：停止时已有数据完整）。
        console.warn(
          `[write-degraded] ${recording.session.recordingId} 收尾冲刷超帽，仍强制排出保尾`,
        );
      }
      recording.session.size += remaining.length;
      recording.pendingWrites.push(remaining);
      recording.pendingWriteBytes += remaining.length;
    }
    this.startSharedWritePump(recording);
    while (recording.writePump) await recording.writePump;
    if (recording.writeError) throw recording.writeError;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      recording.writer.once("error", onError);
      recording.writer.end(() => {
        recording.writer.removeListener("error", onError);
        resolve();
      });
    });
    if (recording.seekWriter) {
      await recording.seekWriter.close();
      if (recording.session.filePath) endSeekWriter(recording.session.filePath);
      recording.seekWriter = null;
      // 共享链收束：输出 filePath、写入字节与最大媒体时间戳，与单录口径一致。
      console.log(
        `[recording ${new Date().toISOString()}] writer-close file=${recording.session.filePath ?? "-"} bytes=${recording.session.size} lastTs=${recording.normalizer.lastTimestampMs}ms (shared-preview)`,
      );
    }
  }

  /** 中断/销毁路径的索引写入器收口（best-effort，绝不阻断主流程）。 */
  private abandonSeekIndex(recording: SharedPreviewRecording): void {
    if (!recording.seekWriter) return;
    void recording.seekWriter.close();
    if (recording.session.filePath) endSeekWriter(recording.session.filePath);
    recording.seekWriter = null;
  }

  /**
   * 观看中的房间开始录制时复用当前上游流：只新增文件写入器，绝不关闭预览 WebSocket。
   * 返回 false 表示尚未积累足够的 FLV 初始化段/关键帧，调用方回退到既有录制路径。
   */
  private async startSharedPreviewRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    actualQuality: string,
    settings: AppSettings,
    origin: import("../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    const previewSession = this.previewSessions.get(room.id);
    const bootstrap = this.preview?.recordingBootstrap?.(room.id);
    // 共享写入器目前复用 FLV 标签及其时间戳归零逻辑；非 FLV 流沿用原有独立录制路径。
    if (
      !previewSession ||
      previewSession.recording ||
      !bootstrap ||
      bootstrap.subarray(0, 3).toString() !== "FLV"
    )
      return false;

    const filePath = recordingFilePath(
      settings.recordingDirectory,
      room.platform,
      room.displayName || room.id,
      this.services.clock.iso(),
      settings.recordingFormat,
      settings.namingRule,
      actualQuality,
      room.id,
    );
    await this.createRecordingFile(filePath, room.id);
    startupTrace?.mark("recording_file_ready");
    const recording = this.services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: status.streamSessionId ?? null,
      streamTitle: status.streamTitle ?? room.displayName,
      quality: actualQuality,
      expectedQuality: settings.quality,
      origin,
    });
    const writer = createWriteStream(filePath, { flags: "a" });
    // 跳播索引：与 runHttp 同链（预览转录制的写盘支路若不接，全程无索引）。
    const seekWriter = await SeekIndexWriter.open(filePath, 0);
    const session = this.newSession(
      recording.id,
      room.id,
      status.streamSessionId ?? null,
      recording.startedAt,
      filePath,
    );
    let resolveDone!: () => void;
    session.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    session.resolveDone = resolveDone;
    const sharedRecording: SharedPreviewRecording = {
      session,
      writer,
      seekWriter,
      // 预览流的时间戳从打开观看起计算；录制文件须在本次开始处重新归零。
      normalizer: new FlvTimestampNormalizer({
        rebaseFromFirstMedia: true,
        appendBaseBytes: 0,
        ...(seekWriter
          ? {
              onTag: (info: FlvTagInfo) =>
                seekWriter.note(
                  info.seqHeader
                    ? { t: info.ts, b: info.fileOffset, s: 1, k: info.tagType }
                    : { t: info.ts, b: info.fileOffset },
                ),
            }
          : {}),
      }),
      pendingWrites: [],
      pendingWriteBytes: 0,
      degradedSince: null,
      droppedBytes: 0,
      writePump: null,
      writeError: null,
    };
    // A volume can disappear after the successful file creation. Keep an error
    // listener for the whole writer lifetime so that a late EIO is surfaced to
    // the recording flow instead of becoming an unhandled EventEmitter error.
    // 共享链起点：带 filePath，供与收束行配对定位。
    console.log(
      `[recording ${new Date().toISOString()}] writer-open file=${filePath} append=false (shared-preview)`,
    );
    if (!writerErrorHooks.has(writer)) {
      writerErrorHooks.add(writer);
      writer.on("error", (error) => {
        sharedRecording.writeError ??= error;
      });
    }

    try {
      this.appendSharedPreviewRecording(sharedRecording, bootstrap);
    } catch (error) {
      writer.destroy();
      await unlink(filePath).catch(() => undefined);
      const err = writeFailure(error, {
        roomId: room.id,
        recordingId: recording.id,
      });
      const failed = this.services.recordings.update(recording.id, {
        state: "failed",
        endedAt: this.services.clock.iso(),
        failureReason: err.toObject(),
      });
      this.services.events.emit({ type: "recording:updated", data: failed });
      throw err;
    }

    previewSession.recording = sharedRecording;
    this.active.set(room.id, session);
    this.services.recordings.update(recording.id, {
      state: "recording",
      filePath,
      ...(origin === "floating"
        ? { streamTitle: path.parse(filePath).name }
        : {}),
    });
    this.services.rooms.setState(room.id, "recording", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: null,
    });
    this.services.events.emit({
      type: "room:updated",
      data: this.enrichRoom(this.services.rooms.get(room.id)!),
    });
    this.services.events.emit({
      type: "recording:updated",
      data: this.services.recordings.get(recording.id)!,
    });
    this.emitServiceStatus();
    await this.notifier.notify("recording_started", room.id, {
      title: room.displayName,
    });
    return true;
  }

  private async startRecordingFromExistingPreview(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    settings: AppSettings,
    origin: import("../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    const preview = this.previewSessions.get(room.id);
    if (!preview) return false;
    // 复用前检查上游新鲜度：静默超阈或从未到数据即丢弃并重新取流。
    // 坑点：仅凭「收到过首包」不等于此刻可用，旧上游可能已干涸或被平台过期。
    // 拆掉旧会话返回 false → 调用方自然回退到现解析 getStreamUrl（与手动链同路）。
    const silentMs = this.services.clock.now() - preview.lastDataAt;
    if (!preview.hasReceivedData || silentMs > PREVIEW_FRESHNESS_MS) {
      console.log(
        `[recording ${new Date().toISOString()}] preview-reuse-reject silentMs=${silentMs} hasData=${preview.hasReceivedData} → 拆旧上游回退现解析`,
      );
      this.previewSessions.delete(room.id);
      void preview.engine.stop().catch(() => undefined);
      return false;
    }
    return this.startSharedPreviewRecording(
      room,
      status,
      preview.actualQuality,
      settings,
      origin,
      startupTrace,
    );
  }

  private async createRecordingFile(
    filePath: string,
    roomId: string,
  ): Promise<void> {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const file = await open(filePath, "w");
      await file.close();
    } catch (error) {
      throw fileCreateError(error, roomId);
    }
  }

  /** 启动期磁盘检查：发 disk:space 事件，低空间只告警不拦截。与取流并行，建文件前必须 await。 */
  private async inspectDiskForStartup(
    settings: AppSettings,
    room: Room,
    startupTrace: PerformanceTrace,
  ): Promise<void> {
    try {
      if (settings.recordingDirectory.length > 0) {
        const space = await this.services.diskGuard.inspect(
          settings.recordingDirectory,
        );
        const total = space.totalBytes || 1;
        const low =
          space.freeBytes < settings.diskGuard.minFreeBytes ||
          (space.freeBytes / total) * 100 < settings.diskGuard.minFreePercent;
        this.services.events.emit({
          type: "disk:space",
          data: {
            directory: settings.recordingDirectory,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
            low,
          },
        });
        // 空间不足只提醒、不拦下录制：能不能录由实际写入决定。用户宁可先录下来再清理，
        // 也不要在开播那一刻被挡在门外——录制本身是核心能力，等清理完直播可能已经结束了。
        // 真的写不进去时，写入失败会给出明确原因（磁盘满/权限等）。
        if (low) {
          const err = new AppError("DISK_SPACE_INSUFFICIENT", "磁盘空间不足", {
            roomId: room.id,
            details: {
              freeBytes: space.freeBytes,
              minFreeBytes: settings.diskGuard.minFreeBytes,
            },
          });
          this.raiseAlert("error", "disk", err);
          await this.notifier.notify("disk_space_low", room.id, {
            title: room.displayName,
          });
        }
      }
      // 归档盘守卫（best-effort）：归档目录在另一块盘时，满盘会让分片搬运/归档写入失败，
      // 此前只查录像目录、归档盘无人看。与录像目录同卷时上面的检查已覆盖，跳过。
      await this.inspectArchiveDiskGuard(settings, room);
      startupTrace.mark("storage_checks_ready");
    } catch (error) {
      startupTrace.mark("storage_checks_ready");
      throw error;
    }
  }

  /** 归档目录空间检查——绝不抛错（守卫自身故障或目录未建都不影响录制启动）。 */
  private async inspectArchiveDiskGuard(
    settings: AppSettings,
    room: Room,
  ): Promise<void> {
    try {
      const dir = settings.pipeline?.archiveDirectory?.trim();
      if (!dir || dir.length === 0) return;
      if (settings.recordingDirectory) {
        try {
          if (statSync(dir).dev === statSync(settings.recordingDirectory).dev)
            return;
        } catch {
          // 归档目录尚未创建：仍按路径检查（diskGuard 自行容错）。
        }
      }
      const space = await this.services.diskGuard.inspect(dir);
      const total = space.totalBytes || 1;
      const low =
        space.freeBytes < settings.diskGuard.minFreeBytes ||
        (space.freeBytes / total) * 100 < settings.diskGuard.minFreePercent;
      this.services.events.emit({
        type: "disk:space",
        data: {
          directory: dir,
          freeBytes: space.freeBytes,
          totalBytes: space.totalBytes,
          low,
        },
      });
      if (low) {
        const err = new AppError(
          "DISK_SPACE_INSUFFICIENT",
          "归档目录所在磁盘空间不足",
          {
            roomId: room.id,
            details: {
              freeBytes: space.freeBytes,
              minFreeBytes: settings.diskGuard.minFreeBytes,
            },
          },
        );
        this.raiseAlert("error", "disk", err);
        await this.notifier.notify("disk_space_low", room.id, {
          title: room.displayName,
        });
      }
    } catch {
      // best-effort：见方法注释。
    }
  }

  /** 调度器发现直播后调用：并发上限、本次开播周期去重、磁盘保护，然后启动录制。manual=手动触发，可在本次直播中显式重录。 */
  async maybeStartRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    opts: {
      manual?: boolean;
      scheduled?: boolean;
      liveStartedAt?: string | null;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
  ): Promise<boolean> {
    const startupTrace = this.performance.begin("recording_start", room);
    if (this.services.resetting) {
      startupTrace.finish("skipped");
      return false;
    }
    // PrePan 钦定边界（2026-09-29）：写盘自动恢复尝试期间用户手动点录制 →
    // 自动重启立即让位，旧场收口（内容保留）后由手动录制接管，绝不两路冲突。
    const recovering = this.active.get(room.id);
    if (opts.manual && recovering?.writeRestartPending) {
      recovering.writeRestartCancelled = true;
      await recovering.writeRestartDone?.catch(() => undefined);
    }
    if (this.active.has(room.id) || this.starting.has(room.id)) {
      startupTrace.finish("skipped");
      return false;
    }
    if (this.recordingsHeld() >= this.settings().maxConcurrentRecordings) {
      const err = new AppError(
        "CONCURRENT_LIMIT_REACHED",
        "录制达到最大并发数量，请在设置内增加最大并发",
        { roomId: room.id, retryable: true },
      );
      this.raiseAlert("warning", "recorder", err);
      this.services.rooms.setState(room.id, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: err,
      });
      startupTrace.finish("skipped", "CONCURRENT_LIMIT_REACHED");
      return false;
    }
    this.starting.add(room.id);
    try {
      return await this.maybeStartRecordingInternal(
        room,
        status,
        opts,
        startupTrace,
      );
    } catch (error) {
      startupTrace.finish(
        "failed",
        error instanceof AppError ? error.code : "RECORDING_START_FAILED",
      );
      throw error;
    } finally {
      this.starting.delete(room.id);
    }
  }

  /** 已占用的录制额度：已落库的在录 + 正在启动但尚未产生录制行的房间。 */
  private recordingsHeld(): number {
    let starting = 0;
    for (const id of this.starting) if (!this.active.has(id)) starting += 1;
    return this.services.recordings.activeCount() + starting;
  }

  private async maybeStartRecordingInternal(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    opts: {
      manual?: boolean;
      scheduled?: boolean;
      liveStartedAt?: string | null;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
    startupTrace: PerformanceTrace,
  ): Promise<boolean> {
    this.detachHighlightBufferForRecording(room.id);
    startupTrace.mark("highlight_buffer_stopped");
    const settings = this.settings();
    const sessionId = status.streamSessionId ?? null;
    if (
      !opts.manual &&
      !opts.scheduled &&
      opts.liveStartedAt &&
      this.services.recordings.hasRecordingSince(room.id, opts.liveStartedAt)
    ) {
      // 本次开播已录制过（例如用户手动停止），保持去重但不能遗留“检测中”。
      this.services.rooms.setState(room.id, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(room.id)!),
      });
      startupTrace.finish("skipped", "ALREADY_RECORDED");
      return false;
    }

    // 磁盘检查与后续取流并行发起；低空间告警仍必须在任何建文件之前生效，
    // 因此所有会创建文件的路径都会先 await 这里返回的 promise。
    const diskCheckReady = this.inspectDiskForStartup(
      settings,
      room,
      startupTrace,
    );
    // 提前路径（取流抛错/被并发抢占）可能不再 await：先挂空 catch 防未处理拒绝，
    // 真正需要磁盘结果的路径仍 await 原 promise 以保留失败语义。
    void diskCheckReady.catch(() => undefined);

    const origin = opts.origin ?? (opts.manual ? "manual" : "automatic");
    // 已有预览会话：先等磁盘告警落地再尝试复用（复用会建文件），避免时序回退。
    if (this.previewSessions.has(room.id)) {
      await diskCheckReady;
      if (
        await this.startRecordingFromExistingPreview(
          room,
          status,
          settings,
          origin,
          startupTrace,
        )
      ) {
        startupTrace.mark("reused_preview_stream");
        startupTrace.finish("ok");
        return true;
      }
    }

    const cookie = await this.services.platformCookie(room.platform);
    startupTrace.mark("platform_cookie_ready");
    const stream = await this.services
      .adapterFor(room.platform)
      .getStreamUrl(room.url, settings.quality, cookie);
    startupTrace.mark("stream_url_ready");
    // The stream lookup is asynchronous. A scheduler/manual request may have
    // claimed this room while it was in flight; never create a second session
    // or report a successful manual start in that case.
    if (this.active.has(room.id)) {
      startupTrace.finish("skipped");
      return false;
    }
    // 自此可能创建文件：磁盘检查（含低空间告警/通知）必须已完成。
    await diskCheckReady;
    // 已有观看预览时复用它的上游流；只有尚未形成可写入的关键帧缓存时才回退旧路径。
    if (
      await this.startSharedPreviewRecording(
        room,
        status,
        stream.actualQuality,
        settings,
        origin,
        startupTrace,
      )
    ) {
      startupTrace.finish("ok");
      return true;
    }
    this.previewTransitions.add(room.id);
    try {
      // 无观看预览时维持原有独立录制路径。
      await this.stopPreviewStream(room.id, true);
      if (this.active.has(room.id)) {
        startupTrace.finish("skipped");
        return false;
      }
      const filePath = recordingFilePath(
        settings.recordingDirectory,
        room.platform,
        room.displayName || room.id,
        this.services.clock.iso(),
        settings.recordingFormat,
        settings.namingRule,
        stream.actualQuality,
        room.id,
      );
      await this.createRecordingFile(filePath, room.id);
      startupTrace.mark("recording_file_ready");
      // 悬浮录制的历史标题使用最终文件基名，确保它和设置里的命名规则完全一致。
      const streamTitle =
        opts.origin === "floating"
          ? path.parse(filePath).name
          : (status.streamTitle ?? room.displayName);
      const recording = this.services.recordings.create({
        roomId: room.id,
        roomName: room.displayName,
        platform: room.platform,
        streamSessionId: sessionId,
        streamTitle,
        quality: stream.actualQuality,
        expectedQuality: settings.quality,
        origin: opts.origin ?? (opts.manual ? "manual" : "automatic"),
      });
      this.services.rooms.setState(room.id, "recording", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const session = this.newSession(
        recording.id,
        room.id,
        sessionId,
        recording.startedAt,
        filePath,
      );
      session.done = done;
      session.resolveDone = resolveDone;
      session.startupTrace = startupTrace;
      this.active.set(room.id, session);
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(room.id)!),
      });
      this.services.events.emit({ type: "recording:updated", data: recording });
      this.emitServiceStatus();
      await this.notifier.notify("recording_started", room.id, {
        title: room.displayName,
      });

      const run = this.runSession(
        room,
        recording.id,
        stream,
        filePath,
        session,
        0,
      );
      session.pullDone = run;
      void run.catch(() => undefined);
      return true;
    } finally {
      this.previewTransitions.delete(room.id);
    }
  }

  private async runSession(
    room: Room,
    recordingId: string,
    stream: {
      url: string;
      format: "flv" | "hls";
      headers?: Record<string, string>;
    },
    filePath: string,
    session: ActiveSession,
    attempt: number,
  ): Promise<void> {
    const settings = this.settings();
    const engine = this.services.engineFor();
    const generation = session.generation;
    session.engine = engine;
    session.filePath = filePath;
    this.services.rooms.setState(room.id, "recording");
    if (session.segments === 0) this.preview?.resetRoom(room.id);

    let startedConfirmed = false;
    let gotData = false;
    const pendingTimeout = this.services.clock.setTimeout(() => {
      if (!gotData) {
        const err = new AppError(
          "RECORDING_START_TIMEOUT",
          "等待直播数据超时",
          { roomId: room.id, recordingId, retryable: true },
        );
        void this.handleDisconnect(
          room,
          recordingId,
          err.toObject(),
          attempt,
          session.timestampOffsetMs,
        );
      }
    }, START_TIMEOUT_MS);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const input = {
        url: stream.url,
        format: stream.format,
        ...(stream.headers ? { headers: stream.headers } : {}),
      };
      // 第 2 段起接着写同一个文件：追加写入 + 时间戳顺延到上一段结尾之后。
      const resume = {
        append: session.segments > 0,
        timestampOffsetMs: session.timestampOffsetMs,
      };
      for await (const event of engine.start(input, filePath, resume)) {
        if (session.generation !== generation) return;
        if (session.stopRequested) break;
        switch (event.type) {
          case "file_created": {
            startedConfirmed = true;
            this.services.recordings.update(recordingId, {
              state: "recording",
              filePath: event.filePath,
            });
            this.services.events.emit({
              type: "recording:updated",
              data: this.services.recordings.get(recordingId)!,
            });
            break;
          }
          case "data": {
            if (!gotData) {
              gotData = true;
              clearTimeout2(this.services, pendingTimeout);
              session.startupTrace?.finish("ok");
            }
            session.size += event.chunk.length;
            const now = this.services.clock.now();
            // 恢复后拿到第一份数据：把中断期间的缺失时长结算到本次录制上。
            if (session.gapStartAt !== null) {
              const gapMs = Math.max(0, now - session.gapStartAt);
              session.missingMs += gapMs;
              if (gapMs < GAP_ROW_MIN_MS) {
                console.log(`[recording ${new Date().toISOString()}] short-gap ${gapMs}ms（不记条目，时长已累计）`);
              } else {
              // 中断事件存证：先存证据再定归因（kind 为当前可判的粗归因，数据层留给后续细分）。
              this.services.recordings.insertGap({
                recordingId: session.recordingId,
                startedAt: new Date(session.gapStartAt).toISOString(),
                endedAt: new Date(now).toISOString(),
                missingMs: gapMs,
                kind: this.shuttingDown
                  ? "service_restart"
                  : "stream_disconnect",
                evidence: JSON.stringify({
                  gapStartAt: session.gapStartAt,
                  size: session.size,
                }),
              });
              }
              session.gapStartAt = null;
            }
            session.lastDataAt = now;
            this.preview?.broadcastFrame(room.id, event.chunk);
            break;
          }
          case "stream_format_changed": {
            const info = new AppError(
              "STREAM_FORMAT_CHANGED",
              "流格式变化，已自动切换",
              { roomId: room.id, recordingId },
            );
            this.raiseAlert("info", "recorder", info);
            break;
          }
          case "completed": {
            // 这一路拉流已结束（写流已关闭），接力时无需再等它。
            session.pullDone = null;
            await this.handleNaturalEnd(
              room,
              recordingId,
              event.fileSize ?? session.size,
              session,
              attempt,
              event.endTimestampMs ?? session.timestampOffsetMs,
            );
            return;
          }
          case "error": {
            clearTimeout2(this.services, pendingTimeout);
            // 同上：错误事件意味着该路拉流已收尾，写流已关闭。
            session.pullDone = null;
            await this.handleDisconnect(
              room,
              recordingId,
              event.error,
              attempt,
              event.endTimestampMs ?? session.timestampOffsetMs,
            );
            return;
          }
        }
      }
      // 已被新的续录会话取代：不在这里收尾，交给接管的那一代会话处理。
      if (session.generation !== generation) return;
      // 退出中：写流已经落盘，记录状态交给下次启动的恢复流程统一收口，这里不再改库、不再跑后处理。
      if (this.shuttingDown) return;
      if (session.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, "ended", {
          endReason: session.requestedEndReason ?? "stopped",
        });
        return;
      }
      if (!startedConfirmed) {
        const err = new AppError("RECORDING_START_FAILED", "录制启动失败", {
          roomId: room.id,
          recordingId,
          retryable: true,
        });
        await this.failRecording(room, recordingId, err.toObject(), "recorder");
        session.startupTrace?.finish("failed", err.code);
        return;
      }
      await this.completeRecording(room, recordingId, session.size, "ended");
    } catch (err) {
      if (session.generation !== generation || this.shuttingDown) return;
      const appErr =
        err instanceof AppError
          ? err
          : new AppError(
              "RECORDING_START_FAILED",
              `录制异常: ${(err as Error).message}`,
              { roomId: room.id, recordingId, retryable: true },
            );
      session.startupTrace?.finish("failed", appErr.code);
      await this.failRecording(
        room,
        recordingId,
        appErr.toObject(),
        "recorder",
      );
    } finally {
      clearTimeout2(this.services, pendingTimeout);
    }
  }

  /**
   * 断流重连：退避后重新取地址继续拉流，恢复后接着写同一个文件——不新开文件、不新建记录。
   * 重连额度按轮计算：稳定录满 STABLE_RESET_MS 后归还，几小时前的旧故障不再拖累现在这一次抖动。
   * 额度耗尽才收尾：有数据 → 已完成并注明中断；一个字节都没有 → 失败。
   */
  private async handleDisconnect(
    room: Room,
    recordingId: string,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    const session = this.active.get(room.id);
    if (!session) return;
    // 启动超时与随后的断流可能同时触发重连：只允许一次接力在途。
    await this.withHandoff(session, () =>
      this.handleDisconnectInner(
        room,
        recordingId,
        session,
        error,
        attempt,
        endTimestampMs,
      ),
    );
  }

  private async handleDisconnectInner(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    // 本段写到哪：下一段时间戳从这里接着走，拼接处不会跳回开头。
    if (endTimestampMs > session.timestampOffsetMs)
      session.timestampOffsetMs = endTimestampMs;
    // 缺失时长从"最后一次收到数据"算起，恢复拿到数据时结算。
    if (session.gapStartAt === null)
      session.gapStartAt = session.lastDataAt || this.services.clock.now();

    // 写盘类失败与网络无关，网络重试没有意义；但磁盘瞬时故障（USB 抖动/休眠唤醒）值得
    // 自动恢复（PrePan 需求①）：退避限次重启新段续录、每场累计封顶，每次尝试落日志与
    // 失败原因，重启也失败/封顶耗尽才终停（终停必带明确原因）。其他非可重试错误维持直接收尾。
    if (error.retryable === false) {
      if (isWriteFailure(error)) {
        await this.restartAfterWriteFailure(room, recordingId, session, error);
      } else {
        await this.finishInterrupted(room, recordingId, humanizeFailure(error));
      }
      return;
    }

    const settings = this.settings();
    // Preserve the explicit opt-out; positive legacy attempt counts no longer cap network recovery.
    if (settings.retry.maxAttempts === 0) {
      await this.finishInterrupted(room, recordingId, reconnectExhausted(error, 0));
      return;
    }
    // 稳定录满 STABLE_RESET_MS 后重置退避阶段，旧故障不拖慢新的恢复。
    let effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    let cause = error;

    // Transient failures keep recovering. Only confirmed offline, explicit stop,
    // shutdown, deletion, or a non-retryable error ends this loop.
    if (effective === 0 || session.reconnectSince === undefined) {
      session.reconnectSince = this.services.clock.now();
      session.recoveringAlerted = false;
    }
    const reconnectSince = session.reconnectSince;
    for (;;) {
      if (this.shuttingDown || this.active.get(room.id) !== session) return;
      if (session.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, "ended", {
          endReason: session.requestedEndReason ?? "stopped",
        });
        return;
      }
      if (cause.retryable === false) {
        if (isWriteFailure(cause)) await this.restartAfterWriteFailure(room, recordingId, session, cause);
        else await this.finishInterrupted(room, recordingId, humanizeFailure(cause));
        return;
      }
      if (
        !session.recoveringAlerted &&
        this.services.clock.now() - reconnectSince >= RECONNECT_ALERT_AFTER_MS
      ) {
        session.recoveringAlerted = true;
        // 坑点：告警只提示不改行为——持续重试不停录是产品底线，此处绝不触发收尾。
        this.raiseAlert("warning", "recorder", new AppError(
          "NETWORK_UNAVAILABLE",
          "正在努力恢复该直播间录制",
          { roomId: room.id, retryable: true },
        ));
      }
      const prevState = this.services.rooms.get(room.id)?.monitorState;
      const recording = this.services.recordings.update(recordingId, {
        state: "reconnecting",
        retryCount: effective,
      });
      this.services.rooms.setState(room.id, "reconnecting");
      // 状态真变了才补发房间事件：退避循环每轮重试都会重复 setState，无守卫则每轮广播冗余 room:updated；
      // 而只发 recording:updated 会让监控卡片/列表停留在「录制中」直到下个检测周期（前端靠 room:updated 切「重连中」）。
      if (prevState !== "reconnecting") {
        const fresh = this.services.rooms.get(room.id);
        if (fresh) {
          this.services.events.emit({
            type: "room:updated",
            data: this.enrichRoom(fresh),
          });
        }
      }
      this.services.events.emit({ type: "recording:updated", data: recording });

      // Network recovery keeps retrying until confirmed offline or explicitly stopped.
      const delay = RECONNECT_CHAIN_SEC[Math.min(effective, RECONNECT_CHAIN_SEC.length - 1)] ?? 0;
      this.raiseAlert(
        "warning",
        "recorder",
        new AppError(
          cause.code,
          `${causeLabel(cause.code)}，正在自动重试（第 ${effective + 1} 次）`,
          { roomId: room.id, recordingId, retryable: true },
        ),
      );

      await this.waitForReconnect(session, Math.min(30_000, delay * 1000 * (0.8 + Math.random() * 0.4)));
      if (this.shuttingDown || this.active.get(room.id) !== session) return;
      // 退避期间用户点了停止：按手动停止收尾。直接 return 会把记录永远留在"重连中"、占着并发名额，
      // 停止录制的请求也会一直挂在 session.done 上（唯一的出口是重启服务）。
      if (this.active.get(room.id)?.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, "ended", {
          endReason: session.requestedEndReason ?? "stopped",
        });
        return;
      }
      const next = effective + 1;
      try {
        const cookie = await this.services.platformCookie(room.platform);
        // 先确认主播还在不在播：只有明确的"未开播"才是正常收尾，不该白等重试再报"失败"。
        const live = await this.services
          .adapterFor(room.platform)
          .checkLiveStatus(room.url, cookie);
        if (live.status === "offline") {
          // 连续两次都判未开播才收尾：单次空响应可能只是平台瞬时抖动，不该把正在录的收掉。
          if (await this.confirmOffline(room, cookie)) {
            await this.completeRecording(
              room,
              recordingId,
              session.size,
              "ended",
            );
            return;
          }
          cause = new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
            roomId: room.id,
            recordingId,
            retryable: true,
          }).toObject();
          effective = next;
          continue;
        }
        // 探测失败/受限（error/restricted）只是没问到确定结论，不代表下播：继续重试，不据此收尾。
        if (live.status !== "live") {
          cause =
            live.error ??
            new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
              roomId: room.id,
              recordingId,
              retryable: true,
            }).toObject();
          effective = next;
          continue;
        }
        const stream = await this.services
          .adapterFor(room.platform)
          .getStreamUrl(room.url, settings.quality, cookie);
        const cur = this.active.get(room.id);
        if (!cur || this.shuttingDown) return;
        if (cur.stopRequested) continue;
        await this.resumeSession(room, recordingId, cur, stream, next);
        return;
      } catch (err) {
        // 取流/探测抛错同样属于可重试的中断：消耗一次额度继续下一轮，额度耗尽才按真正原因收尾。
        cause = err instanceof AppError ? err.toObject() : cause;
        effective = next;
      }
    }
  }

  /**
   * 写盘失败自动恢复录制（PrePan 钦定 2026-09-29）：磁盘出错不停死录制，
   * **失败后立即重启、不间隔、共 3 次**；每次尝试落 [record] 日志与失败原因；
   * 3 次都失败才终停（历史必带明确原因）；用户手动介入（点停止/点录制）立即让位。
   */
  private async restartAfterWriteFailure(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    error: ErrorObject,
  ): Promise<void> {
    session.writeRestartPending = true;
    let resolveDone!: () => void;
    session.writeRestartDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    try {
      // 稳定录满一段后归还额度（与重连额度同口径）：旧故障不拖累现在这一次。
      if (
        this.services.clock.now() - session.lastRecoveryAt >=
        STABLE_RESET_MS
      ) {
        session.writeRestartCount = 0;
      }
      const settings = this.settings();
      let cause = error;
      while (session.writeRestartCount < WRITE_RESTART_ATTEMPTS) {
        // 用户手动介入（点停止/点录制接管）：立即让位，绝不再自动重启（PrePan 钦定边界）。
        if (session.stopRequested || session.writeRestartCancelled) {
          await this.completeRecording(
            room,
            recordingId,
            session.size,
            "ended",
            {
              endReason: session.requestedEndReason ?? "stopped",
            },
          );
          return;
        }
        session.writeRestartCount += 1;
        const nth = session.writeRestartCount;
        // 每次尝试落日志与失败原因（诊断盲区教训：失败原因必须进 backend.log）。
        console.log(
          `[record] 写盘失败自动重启 ${recordingId}（第 ${nth}/${WRITE_RESTART_ATTEMPTS} 次）：${cause.message}`,
        );
        const prevState = this.services.rooms.get(room.id)?.monitorState;
        const recording = this.services.recordings.update(recordingId, {
          state: "reconnecting",
          retryCount: nth,
          failureReason: cause,
        });
        this.services.rooms.setState(room.id, "reconnecting");
        // 与重连循环同款：状态真变才广播 room:updated，避免冗余推送。
        if (prevState !== "reconnecting") {
          const fresh = this.services.rooms.get(room.id);
          if (fresh) {
            this.services.events.emit({
              type: "room:updated",
              data: this.enrichRoom(fresh),
            });
          }
        }
        this.services.events.emit({
          type: "recording:updated",
          data: recording,
        });
        try {
          const cookie = await this.services.platformCookie(room.platform);
          // 与重连同款双探：只有明确未开播才正常收尾，探测无结论不据此收尾。
          const live = await this.services
            .adapterFor(room.platform)
            .checkLiveStatus(room.url, cookie);
          if (live.status === "offline") {
            if (await this.confirmOffline(room, cookie)) {
              await this.completeRecording(
                room,
                recordingId,
                session.size,
                "ended",
              );
              return;
            }
            cause = new AppError(
              "NETWORK_UNAVAILABLE",
              "暂时无法确认直播状态",
              {
                roomId: room.id,
                recordingId,
                retryable: true,
              },
            ).toObject();
            continue;
          }
          if (live.status !== "live") {
            cause =
              live.error ??
              new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
                roomId: room.id,
                recordingId,
                retryable: true,
              }).toObject();
            continue;
          }
          const stream = await this.services
            .adapterFor(room.platform)
            .getStreamUrl(room.url, settings.quality, cookie);
          // 取流回来再查一次手动介入：手动开录/停止必须立即让位（并发判定收窄）。
          if (session.stopRequested || session.writeRestartCancelled) {
            await this.completeRecording(
              room,
              recordingId,
              session.size,
              "ended",
              {
                endReason: session.requestedEndReason ?? "stopped",
              },
            );
            return;
          }
          const cur = this.active.get(room.id);
          if (!cur) return;
          await this.resumeSession(room, recordingId, cur, stream, nth);
          // 恢复成功：清掉尝试期的失败原因，历史页只在真正失败/中断时显示原因。
          this.services.recordings.update(recordingId, { failureReason: null });
          return;
        } catch (err) {
          cause = err instanceof AppError ? err.toObject() : cause;
        }
      }
      await this.finishInterrupted(
        room,
        recordingId,
        writeRestartExhausted(cause, session.writeRestartCount),
      );
    } finally {
      session.writeRestartPending = false;
      session.writeRestartDone = undefined;
      resolveDone();
    }
  }

  /**
   * 判定"主播是否真的下播"：单次探测到 offline 可能只是平台的瞬时响应（抖音下播前后遇到过
   * 空响应），所以紧接再探一次，只有连续两次都说未开播才认定下播——避免一次瞬时空响应
   * 把正在进行的录制提前收掉。第二次探测失败一律按"没确认"处理（继续重试，不据此收尾）。
   */
  private async confirmOffline(
    room: Room,
    cookie: string | undefined,
  ): Promise<boolean> {
    try {
      const again = await this.services
        .adapterFor(room.platform)
        .checkLiveStatus(room.url, cookie);
      return again.status === "offline";
    } catch {
      return false;
    }
  }

  /**
   * 恢复续录：先把上一路拉流彻底停掉（含关闭写流），再接着写同一个文件，而不是新开一个。
   * 顺序不能反：启动超时重试时旧连接可能还挂着，若不等它收尾，新旧两个写流会同时写同一个文件。
   */
  private async resumeSession(
    room: Room,
    recordingId: string,
    session: ActiveSession,
    stream: {
      url: string;
      format: "flv" | "hls";
      headers?: Record<string, string>;
    },
    attempt: number,
  ): Promise<void> {
    // 先推进代次让旧会话失效，否则它收到错误事件后会再走一遍重连、重复处理。
    session.generation += 1;
    await session.engine?.stop().catch(() => undefined);
    await this.waitForPullToStop(session);
    session.segments += 1;
    session.lastRecoveryAt = this.services.clock.now();
    const run = this.runSession(
      room,
      recordingId,
      stream,
      session.filePath!,
      session,
      attempt,
    );
    session.pullDone = run;
    void run.catch(() => undefined);
  }

  /**
   * 接力互斥：启动超时、断流、流自然结束可能同时触发续录。
   * 若两次接力同时在跑，各自会起一路拉流、两路都往同一个文件写，文件必然损坏，因此同一会话只允许一次在途。
   */
  private async withHandoff(
    session: ActiveSession,
    action: () => Promise<void>,
  ): Promise<void> {
    if (session.handingOff) return;
    session.handingOff = true;
    try {
      await action();
    } finally {
      session.handingOff = false;
    }
  }

  /** Stop and shutdown wake the backoff immediately and remove its timer. */
  private waitForReconnect(session: ActiveSession, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout2(this.services, timer);
        if (session.wakeReconnect === wake) delete session.wakeReconnect;
        resolve();
      };
      const timer = this.services.clock.setTimeout(wake, ms);
      session.wakeReconnect = wake;
    });
  }

  /** 等旧拉流收尾（正常会被 stop() 立刻打断）；引擎万一不响应 stop，也不能把重连永久卡住。 */
  private async waitForPullToStop(session: ActiveSession): Promise<void> {
    const pull = session.pullDone;
    if (!pull) return;
    await Promise.race([
      pull.catch(() => undefined),
      new Promise<void>((resolve) =>
        this.services.clock.setTimeout(resolve, PULL_STOP_GRACE_MS),
      ),
    ]);
  }

  /**
   * 中断收尾（重连耗尽 / 写盘失败 / 一直拿不到数据）：
   * 文件里有数据 → 标"已完成"并注明中断——几小时的有效录像不该因为最后一段网络中断被整条判失败；
   * 一个字节都没有 → 才按失败处理（不产生一个"已完成"的空文件）。
   */
  private async finishInterrupted(
    room: Room,
    recordingId: string,
    err: AppError,
    preservePreview = false,
  ): Promise<void> {
    const session = this.active.get(room.id);
    const size = session?.size ?? 0;
    // 失败原因落库统一富化（reasonCategory）+落日志（[record] 同 [verify] 款，诊断盲区教训）。
    const failure = withReasonCategory(err.toObject());
    if (size > 0) {
      console.log(
        `[record] 录制中断收尾 ${recordingId}：已录内容保留（${failure.code}）${failure.message}`,
      );
      await this.completeRecording(room, recordingId, size, "stream_lost", {
        preservePreview,
        endReason: "interrupted",
        failure,
      });
      this.raiseAlert("error", "recorder", err);
      this.services.events.emit({
        type: "recording:updated",
        data: this.services.recordings.get(recordingId)!,
      });
      await this.notifier.notify("recording_failed", room.id, {
        title: room.displayName,
      });
      return;
    }
    await this.failRecording(
      room,
      recordingId,
      failure,
      "recorder",
      preservePreview,
    );
  }

  /** 删除联动兜底：行被删而会话仍在录=停捕获拆链+清房间录制态，房间不留残影。 */
  async stopActiveSessionForDeletion(recordingId: string): Promise<void> {
    const entry = [...this.active.entries()].find(
      ([, s]) => s.recordingId === recordingId,
    );
    if (!entry) return;
    const [roomId, session] = entry;
    session.stopRequested = true;
    session.wakeReconnect?.();
    session.requestedEndReason = "stopped";
    const previewSession = this.previewSessions.get(roomId);
    const sharedRecording = previewSession?.recording;
    if (previewSession && sharedRecording?.session === session) {
      previewSession.recording = null;
      try {
        await this.closeSharedPreviewRecording(sharedRecording);
      } catch {
        sharedRecording.writer.destroy();
        this.abandonSeekIndex(sharedRecording);
      }
    }
    this.active.delete(roomId);
    const room = this.services.rooms.get(roomId);
    if (room) {
      this.services.rooms.setState(roomId, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(roomId)!),
      });
    }
  }

  async stopRecording(
    roomId: string,
    endReason: RecordingEndReason = "stopped",
  ): Promise<void> {
    const session = this.active.get(roomId);
    if (!session) return;
    session.stopRequested = true;
    session.wakeReconnect?.();
    session.requestedEndReason = endReason;
    {
      const room = this.services.rooms.get(roomId);
      if (room) {
        this.services.rooms.setAutoRecordStopped(
          room.id,
          room.liveStartedAt ?? this.services.clock.iso(),
        );
      }
    }
    const previewSession = this.previewSessions.get(roomId);
    const sharedRecording = previewSession?.recording;
    if (previewSession && sharedRecording?.session === session) {
      previewSession.recording = null;
      const room = this.services.rooms.get(roomId)!;
      try {
        await this.closeSharedPreviewRecording(sharedRecording);
        await this.completeRecording(
          room,
          session.recordingId,
          session.size,
          "ended",
          { preservePreview: true, endReason },
        );
        // 弹窗已关闭时共享上游流仍会为录制持续到这里；录制结束后没有观看者就收掉它。
        if (!this.preview?.hasClients(roomId))
          await this.stopPreviewStream(roomId);
      } catch (error) {
        sharedRecording.writer.destroy();
        this.abandonSeekIndex(sharedRecording);
        await this.failRecording(
          room,
          session.recordingId,
          writeFailure(error, {
            roomId,
            recordingId: session.recordingId,
          }).toObject(),
          "recorder",
          true,
        );
      }
      return;
    }
    await session.engine?.stop();
    await session.done;
  }

  /** 片段导出进度快照（0-100）：导出进行中为数字，供历史列表显示「导出中 x%」。 */
  /** 删除联动：取消该片段的在途导出（立即真停，不留孤儿任务）。 */
  cancelClipExport(recordingId: string): void {
    const abort = this.clipExportAborts.get(recordingId);
    if (!abort) return;
    this.clipExportAborts.delete(recordingId);
    abort.abort();
  }

  clipExportProgress(recordingId: string): number | null {
    return this.clipProgress.get(recordingId) ?? null;
  }

  /**
   * 保存命名后后台导出选区（导出不停录，保存后跑到底无取消）：
   * 完成时按当前标题落盘改名（标题=文件名），撞名加序号绝不覆盖，源文件永远在保护名单。
   */
  async exportClip(
    recordingId: string,
    startSecond: number,
    endSecond: number,
    name: string,
  ): Promise<{
    source: import("../types/index.js").Recording;
    clip: import("../types/index.js").Recording;
  }> {
    const source = this.services.recordings.get(recordingId);
    if (
      !source ||
      (source.state !== "recording" && source.state !== "reconnecting")
    ) {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "仅录制中的录像可导出选区",
        { recordingId },
      );
    }
    // 同选区防重复提交；不同选区可并行导出（多条选区同时导出是合法场景），全局上限防资源风暴。
    const selectionKey = `${recordingId}:${startSecond}-${endSecond}`;
    if (this.clipExports.has(selectionKey)) {
      throw new AppError(
        "CONCURRENT_LIMIT_REACHED",
        "相同选区已有片段导出进行中，请稍后再试",
        { recordingId },
      );
    }
    if (this.clipExports.size >= MAX_PARALLEL_CLIP_EXPORTS) {
      throw new AppError(
        "CONCURRENT_LIMIT_REACHED",
        "同时导出的片段过多，请等待部分导出完成后再试",
        { recordingId },
      );
    }
    const title = validateClipName(name, recordingId);
    const elapsed = Math.max(
      0,
      Math.floor(
        (this.services.clock.now() - Date.parse(source.startedAt)) / 1000,
      ),
    );
    if (startSecond < 0 || endSecond <= startSecond || endSecond > elapsed) {
      throw new AppError(
        "CONFIG_INVALID",
        "选区必须在当前已录制时长内，且至少为 1 秒",
        { recordingId },
      );
    }
    if (!source.filePath) {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "录像文件尚未就绪，请稍后再试",
        { recordingId },
      );
    }
    const file = path.parse(source.filePath);
    const clip = this.services.recordings.create({
      roomId: source.roomId,
      roomName: source.roomName,
      platform: source.platform,
      streamSessionId: source.streamSessionId,
      streamTitle: title,
      ...(source.quality ? { quality: source.quality } : {}),
      ...(source.expectedQuality
        ? { expectedQuality: source.expectedQuality }
        : {}),
      origin: "clip",
    });
    const outputPath = path.join(
      file.dir,
      `${file.name}_clip_${startSecond}-${endSecond}_${clip.id}${file.ext}`,
    );
    const pending = this.services.recordings.update(clip.id, {
      state: "processing",
      filePath: outputPath,
      // 选区起止在创建时即映射到时间轴：导出中历史行时长即选区时长（不随录制增长回退）。
      startedAt: new Date(
        Date.parse(source.startedAt) + startSecond * 1000,
      ).toISOString(),
      endedAt: new Date(
        Date.parse(source.startedAt) + endSecond * 1000,
      ).toISOString(),
    });
    this.clipExports.set(selectionKey, clip.id);
    const abort = new AbortController();
    this.clipExportAborts.set(clip.id, abort);
    void (async () => {
      const selectionMs = (endSecond - startSecond) * 1000;
      // 进度节流：整数百分比变化才发、间隔 ≥500ms（onProgress 是高频回调，直接进 SSE 会刷屏）。
      let lastPct = -1;
      let lastEmitAt = 0;
      try {
        const result = await exportClipFile(
          source.filePath!,
          outputPath,
          startSecond,
          endSecond,
          {
            ...(abort.signal.aborted ? {} : { signal: abort.signal }),
            onProgress: ({ outTimeMs }) => {
              const pct = Math.max(
                0,
                Math.min(99, Math.floor((outTimeMs / selectionMs) * 100)),
              );
              const now = this.services.clock.now();
              if (
                pct <= lastPct ||
                (lastEmitAt !== 0 && now - lastEmitAt < 500)
              )
                return;
              lastPct = pct;
              lastEmitAt = now;
              const row = this.services.recordings.get(clip.id);
              if (row) {
                this.clipProgress.set(clip.id, pct);
                this.services.events.emit({
                  type: "recording:updated",
                  data: { ...row, progressPercent: pct },
                });
              }
            },
          },
        );
        const current = this.services.recordings.get(clip.id) ?? pending;
        const currentPath = current.filePath ?? outputPath;
        if (!result.ok) {
          // 失败：主行只留「片段导出失败」，技术原因进 details；半成品即刻清理。
          const reason = result.stderr.trim().slice(-200);
          const failed = this.services.recordings.update(clip.id, {
            state: "failed",
            failureReason: new AppError(
              "RECORDING_FILE_CORRUPTED",
              "片段导出失败",
              {
                recordingId: clip.id,
                ...(reason ? { details: { reason } } : {}),
              },
            ).toObject(),
          });
          this.clipProgress.delete(clip.id);
          this.services.events.emit({
            type: "recording:updated",
            data: { ...failed, progressPercent: null },
          });
          await unlink(currentPath).catch(() => undefined);
          return;
        }
        const { landed, finalTitle } = await withClipFinalizeLock(async () => {
          const wanted = sanitizeRenameBase(current.streamTitle);
          const { targetPath, base } = await uniqueTargetPath(
            file.dir,
            wanted,
            file.ext,
            [source.filePath!],
            currentPath,
          );
          if (currentPath !== targetPath) {
            try {
              await rename(currentPath, targetPath);
              return { landed: targetPath, finalTitle: base };
            } catch {
              // 落盘改名失败不阻断完成（与确认链改名同容错）：文件留在原处，标题不动。
              return { landed: currentPath, finalTitle: undefined };
            }
          }
          return { landed: targetPath, finalTitle: base };
        });
        const done = this.services.recordings.update(clip.id, {
          state: "completed",
          endReason: "clip_export",
          endedAt: new Date(
            Date.parse(source.startedAt) + endSecond * 1000,
          ).toISOString(),
          fileSizeBytes: result.sizeBytes,
          filePath: landed,
          ...(finalTitle !== undefined ? { streamTitle: finalTitle } : {}),
        });
        this.clipProgress.delete(clip.id);
        // 完成即终态、不进确认链：用户点「保存」时已确认命名（不双弹）。
        this.services.events.emit({
          type: "recording:updated",
          data: { ...done, progressPercent: null },
        });
        // 校验与后处理与正常保存录像完全同链：自动入完整性校验队列 + 按配置自动进管线
        // （未启用管线时的 not_required+自动上传同语义），不依赖手动批量重校验。
        this.finishSegmentProcessing(clip.id);
      } finally {
        // 解除在途占位；源录制全程不碰（导出不停录）。
        this.clipExports.delete(selectionKey);
        this.clipExportAborts.delete(clip.id);
      }
    })();
    this.services.events.emit({ type: "recording:updated", data: pending });
    return {
      source: this.services.recordings.get(recordingId)!,
      clip: pending,
    };
  }

  /**
   * 自然结束（流连接正常关闭但房间可能仍开播）：重新拉流接着写同一个文件，
   * 既避免等调度器下一轮（60s）造成的数据缺口，也不再产生"多出一个文件 + 中途一次录制完成提示"。
   * rapid 用于限制连断连拉的快速循环。
   */
  private async handleNaturalEnd(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    // 与断流重连互斥：同一时刻只允许一次接力，避免两路拉流写同一个文件。
    await this.withHandoff(session, () =>
      this.handleNaturalEndInner(
        room,
        recordingId,
        size,
        session,
        attempt,
        endTimestampMs,
      ),
    );
  }

  private async handleNaturalEndInner(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    if (session.stopRequested) {
      await this.completeRecording(room, recordingId, size, "ended", {
        endReason: session.requestedEndReason ?? "stopped",
      });
      return;
    }
    const settings = this.settings();
    if (settings.retry.maxAttempts === 0) {
      await this.completeRecording(room, recordingId, size, "ended");
      return;
    }
    if (endTimestampMs > session.timestampOffsetMs)
      session.timestampOffsetMs = endTimestampMs;
    if (session.gapStartAt === null)
      session.gapStartAt = session.lastDataAt || this.services.clock.now();
    const effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    const rapid = RECONNECT_CHAIN_SEC[Math.min(effective, RECONNECT_CHAIN_SEC.length - 1)] ?? 0;
    await this.waitForReconnect(session, Math.min(30_000, rapid * 1000 * (0.8 + Math.random() * 0.4)));
    if (this.shuttingDown || this.active.get(room.id) !== session) return;
    if (this.active.get(room.id)?.stopRequested) {
      await this.completeRecording(room, recordingId, size, "ended", {
        endReason: session.requestedEndReason ?? "stopped",
      });
      return;
    }
    try {
      const cookie = await this.services.platformCookie(room.platform);
      // 先确认主播仍开播：已下播则正常收口，避免对结束的直播反复重连。
      const live = await this.services
        .adapterFor(room.platform)
        .checkLiveStatus(room.url, cookie);
      if (
        live.status === "offline" &&
        (await this.confirmOffline(room, cookie))
      ) {
        await this.completeRecording(room, recordingId, size, "ended");
        return;
      }
      if (live.status !== "live") {
        // 没确认下播（或探测失败）不能当"直播正常结束"：按可重试的中断走，额度耗尽时按真正原因收尾。
        const offlineCause =
          live.error ??
          new AppError("NETWORK_UNAVAILABLE", "暂时无法确认直播状态", {
            roomId: room.id,
            recordingId,
            retryable: true,
          }).toObject();
        await this.handleDisconnectInner(
          room,
          recordingId,
          session,
          offlineCause,
          effective + 1,
          session.timestampOffsetMs,
        );
        return;
      }
      const stream = await this.services
        .adapterFor(room.platform)
        .getStreamUrl(room.url, settings.quality, cookie);
      const cur = this.active.get(room.id);
      if (!cur || this.shuttingDown) return;
      if (cur.stopRequested) {
        await this.completeRecording(room, recordingId, cur.size, "ended", {
          endReason: cur.requestedEndReason ?? "stopped",
        });
        return;
      }
      await this.resumeSession(room, recordingId, cur, stream, effective + 1);
    } catch (err) {
      // 主播刚探测到还在播、这里只是取流/探测失败：属于可重试的中断，必须走退避重试并在额度耗尽时记录原因，
      // 不能像以前那样当成"直播正常结束"静默收尾（用户会完全不知道录制为什么停了）。
      // 本方法已在 withHandoff 内，直接进 Inner，避免重复取互斥锁。
      const cause =
        err instanceof AppError
          ? err.toObject()
          : new AppError("NETWORK_UNAVAILABLE", "取流失败", {
              roomId: room.id,
              recordingId,
              retryable: true,
            }).toObject();
      await this.handleDisconnectInner(
        room,
        recordingId,
        session,
        cause,
        effective + 1,
        session.timestampOffsetMs,
      );
    }
  }

  private async completeRecording(
    room: Room,
    recordingId: string,
    size: number,
    endReason: "ended" | "stream_lost",
    options: {
      preservePreview?: boolean;
      endReason?: RecordingEndReason;
      failure?: ErrorObject | null;
    } = {},
  ): Promise<void> {
    // 退出中：只放掉会话，不改库、不发通知、不起后处理——状态交给下次启动的恢复流程统一收口。
    if (this.shuttingDown) {
      this.active.get(room.id)?.resolveDone?.();
      this.active.delete(room.id);
      return;
    }
    // 0 字节录制（流连接后无数据/立即关闭）应标 failed 而非 completed 空文件（QA #165 边界）。
    if (size <= 0) {
      const rec = this.services.recordings.get(recordingId);
      if (rec?.filePath) {
        await unlink(rec.filePath).catch(() => undefined);
      }
      const err = new AppError(
        "RECORDING_EMPTY",
        failureText("RECORDING_EMPTY"),
        { roomId: room.id, recordingId, retryable: true },
      );
      await this.failRecording(
        room,
        recordingId,
        err.toObject(),
        "recorder",
        options.preservePreview ?? false,
      );
      return;
    }
    const session = this.active.get(room.id);
    const rec = this.services.recordings.update(recordingId, {
      state: "completed",
      endedAt: this.services.clock.iso(),
      fileSizeBytes: size,
      // 结束原因与缺失时长随录制落库：历史页据此标注"中途缺失 N 秒"，去重据此判断能否续录。
      endReason:
        options.endReason ??
        (endReason === "stream_lost" ? "interrupted" : "natural"),
      // 收尾时若已经静默很久（断网后连接没断、或重连期间），把这段也算进缺失：
      // 否则用户点了停止只会看到一条"手动停止"，完全不知道最后一段没录进去。
      missingMs: Math.round(
        (session?.missingMs ?? 0) +
          tailSilenceMs(session, this.services.clock.now()),
      ),
      failureReason: options.failure ?? null,
    });
    // 中断收尾要用 4004（stream_lost）告知观看端：这不是正常结束，流是断的。
    if (!options.preservePreview)
      this.preview?.closeRoom(
        room.id,
        endReason === "stream_lost" ? 4004 : 1000,
        endReason,
      );
    this.active.delete(room.id);
    this.emitServiceStatus();
    this.services.rooms.setState(room.id, "completed", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: null,
    });
    // #222：confirmAfterComplete 开启时不发中间 completed 事件（只发最终 awaiting_confirmation），避免「已保存通知 + 确认框」弹两次。
    if (!this.settings().confirmAfterComplete)
      this.services.events.emit({ type: "recording:updated", data: rec });
    this.services.events.emit({
      type: "room:updated",
      data: this.enrichRoom(this.services.rooms.get(room.id)!),
    });
    session?.resolveDone?.();
    // 中断收尾由 finishInterrupted 发"录制失败"通知；这里不能再发一次"录制已结束"，否则用户收到两条互相打架的提醒。
    if (!options.failure)
      await this.notifier.notify("recording_ended", room.id, {
        title: room.displayName,
      });
    // 异步校验文件完整性，不阻塞录制完成响应（#220 询问保留时进入待确认态挂起管线/上传）。
    // A selection export explicitly asks for the completion dialog even when the
    // global "confirm after complete" preference is normally disabled.
    this.finishOrConfirm(recordingId, options.endReason === "clip_export");
  }

  /**
   * 分段完成收尾入口：设置「完成后询问是否保留」开启时，录制完成进入待确认态并挂起
   * 管线/上传（由保留/不保留/超时/重启决定）；关闭时按原流程立即执行分段级收尾。
   */
  private finishOrConfirm(recordingId: string, forceConfirm = false): void {
    const recording = this.services.recordings.get(recordingId);
    if (
      (forceConfirm || this.settings().confirmAfterComplete) &&
      recording?.origin !== "floating"
    ) {
      this.enterPendingConfirmation(recordingId);
    } else {
      this.finishSegmentProcessing(recordingId);
    }
  }

  /** 录制完成进入待确认态：state=awaiting_confirmation，挂起管线/上传，并安排超时自动保留。 */
  private enterPendingConfirmation(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    this.clearConfirmTimer(recordingId);
    const updated = this.services.recordings.update(recordingId, {
      state: "awaiting_confirmation",
    });
    this.services.events.emit({ type: "recording:updated", data: updated });
    const handle = this.services.clock.setTimeout(
      () => this.resumeAfterConfirmation(recordingId),
      KEEP_CONFIRM_TIMEOUT_MS,
    );
    this.confirmTimers.set(recordingId, handle);
  }

  /**
   * 保留决策：恢复管线+上传（等价于原分段级收尾）。清除超时定时器；
   * 文件存在 → completed + 收尾；文件缺失 → failed（无法保留）。
   */
  resumeAfterConfirmation(recordingId: string): void {
    if (this.services.resetting) {
      this.clearConfirmTimer(recordingId);
      this.confirmTimers.set(
        recordingId,
        this.services.clock.setTimeout(
          () => this.resumeAfterConfirmation(recordingId),
          1_000,
        ),
      );
      return;
    }
    const pendingHighlight =
      this.pendingHighlightConfirmations.get(recordingId);
    if (pendingHighlight) {
      this.clearConfirmTimer(recordingId);
      pendingHighlight.decision ??= { keep: true };
      const updated = this.services.recordings.update(recordingId, {
        highlightConfirmationDecision: pendingHighlight.decision.keep,
        highlightConfirmationFileName:
          pendingHighlight.decision.fileName ?? null,
      });
      this.services.events.emit({ type: "recording:updated", data: updated });
      return;
    }
    this.clearConfirmTimer(recordingId);
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (!rec.filePath) {
      const err = new AppError(
        "RECORDING_FILE_CORRUPTED",
        "录像文件已不在原位置，无法保留",
        { recordingId, roomId: rec.roomId, retryable: false },
      );
      const failed = this.services.recordings.update(recordingId, {
        state: "failed",
        failureReason: err.toObject(),
      });
      this.services.events.emit({ type: "recording:updated", data: failed });
      return;
    }
    const updated = this.services.recordings.update(recordingId, {
      state: "completed",
      highlightExportPending: false,
      highlightConfirmationDecision: null,
      highlightConfirmationFileName: null,
    });
    this.services.events.emit({ type: "recording:updated", data: updated });
    this.finishSegmentProcessing(recordingId);
  }

  /** 不保留决策：删除文件 + 删除录制记录，并清除超时定时器。 */
  discardAfterConfirmation(recordingId: string): void {
    this.clearConfirmTimer(recordingId);
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    this.services.pipeline.cancel(recordingId, "录制已删除");
    this.cancelClipExport(recordingId);
    if (rec.filePath) {
      void unlink(rec.filePath).catch(() => undefined);
      void removeMarkerSidecar(rec.filePath);
      void removeSeekIndexSidecar(rec.filePath);
    }
    this.services.recordingMarkers.removeForRecording(recordingId);
    this.services.recordings.remove(recordingId);
    this.services.events.emit({
      type: "recording:deleted",
      data: { id: recordingId },
    });
  }

  /** 启动恢复：上次运行遗留的待确认录制按「默认保留」恢复管线/上传。 */
  resumePendingConfirmations(): void {
    const pending = this.services.recordings
      .list({ pageSize: 100 })
      .items.filter((r) => r.state === "awaiting_confirmation");
    for (const rec of pending) {
      // 进程重启会中断内存中的缓存复制。绝不能把尚未生成的精彩时刻当作
      // 普通待确认录像直接标记 completed；用户若已选择不保留，则兑现删除。
      if (rec.highlightExportPending) {
        if (rec.highlightConfirmationDecision === false) {
          if (rec.filePath) void unlink(rec.filePath).catch(() => undefined);
          this.services.recordings.remove(rec.id);
          this.services.events.emit({
            type: "recording:deleted",
            data: { id: rec.id },
          });
        } else {
          void this.failHighlightExport(
            rec.id,
            rec.roomId,
            rec.filePath ?? "",
            new Error("服务重启中断了精彩时刻导出"),
          );
        }
        continue;
      }
      this.resumeAfterConfirmation(rec.id);
    }
  }

  private clearConfirmTimer(recordingId: string): void {
    const handle = this.confirmTimers.get(recordingId);
    if (handle !== undefined) {
      this.services.clock.clearTimeout(handle);
      this.confirmTimers.delete(recordingId);
    }
  }

  /**
   * 分段级收尾（分段完成/录制完成共用）：异步完整性校验 + 管线入队。
   */
  private finishSegmentProcessing(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (rec.filePath) this.services.verificationQueue.enqueue(rec);
    // 保留即归位：标签数据从 .cache/ 搬到 标签/（无标签文件时为无操作）。
    if (rec.filePath) void promoteMarkerSidecar(rec.filePath);
    // 格式转换已是管线独立步骤；未启用管线时仍触发上传。
    this.services.pipeline.enqueue(recordingId);
  }

  private async failRecording(
    room: Room,
    recordingId: string,
    err: ErrorObject,
    source: string,
    preservePreview = false,
  ): Promise<void> {
    if (this.shuttingDown) {
      this.active.get(room.id)?.resolveDone?.();
      this.active.delete(room.id);
      return;
    }
    const session = this.active.get(room.id);
    const failure = humanizeFailure(err);
    const rec = this.services.recordings.update(recordingId, {
      state: "failed",
      endedAt: this.services.clock.iso(),
      failureReason: failure.toObject(),
    });
    // 失败原因必须落 backend.log（本次事故盲区教训：翻日志查不到为什么停）。
    console.log(
      `[record] 录制失败 ${recordingId}（${failure.code}）：${failure.message}`,
    );
    if (!preservePreview) this.preview?.closeRoom(room.id, 4004, "stream_lost");
    this.active.delete(room.id);
    this.emitServiceStatus();
    this.services.rooms.setState(room.id, "failed", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: failure.toObject(),
    });
    this.services.events.emit({ type: "recording:updated", data: rec });
    this.services.events.emit({
      type: "room:updated",
      data: this.enrichRoom(this.services.rooms.get(room.id)!),
    });
    session?.resolveDone?.();
    this.raiseAlert("error", source, failure);
    await this.notifier.notify("recording_failed", room.id, {
      title: room.displayName,
    });
  }

  private raiseAlert(
    level: "info" | "warning" | "error",
    source: string,
    err: AppError | ErrorObject,
  ): void {
    const alert = this.services.alerts.create({
      level,
      source,
      message: err.message,
      occurredAt: this.services.clock.iso(),
      roomId: err.roomId,
      errorCode: err.code,
      retryable: err.retryable,
    });
    this.services.events.emit({ type: "alert:created", data: alert });
  }
}

function defaultsLite(): AppSettings {
  return {
    recordingDirectory: "",
    maxConcurrentRecordings: 2,
    quality: "original",
    recordingFormat: "source_flv",
    autoRecord: false,
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: {
      enabled: false,
      host: "",
      port: 465,
      secure: true,
      username: "",
      from: "",
      recipients: [],
    },
    dedupeWindowMinutes: 30,
    theme: "system",
    floatingRecorderSize: 36,
    confirmAfterComplete: false,
  };
}

function clearTimeout2(services: Services, handle: unknown): void {
  services.clock.clearTimeout(handle);
}
