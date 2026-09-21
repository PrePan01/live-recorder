import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
  causeLabel,
  failureText,
  humanizeFailure,
  reconnectExhausted,
  writeFailure,
} from "./recording-failure.js";
import { recordingFilePath } from "../storage/file-organizer.js";
import { checkFileIntegrity } from "../recorder/integrity.js";
import { mp4PathFor, remuxFlvToMp4 } from "../recorder/remux.js";
import type { RecordingEvent } from "../recorder/engine.js";
import { FlvTimestampNormalizer } from "../recorder/stream-recorder.js";
import { HighlightBuffer } from "../recorder/highlight-buffer.js";
import { ulid } from "../utils/id.js";
import type { Notifier } from "./notifier.js";
import type { Services } from "./services.js";

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
/** 开录后多久还没写出文件即视为拿不到数据 */
const START_TIMEOUT_MS = 30_000;
/** 恢复后稳定录满这么久，就归还重连额度——几小时前的旧故障不该拖累现在这一次抖动。 */
const STABLE_RESET_MS = 60_000;
/** 续录前旧流收尾上限 */
const PULL_STOP_GRACE_MS = 3_000;
/** 退出前等写流落盘的上限 */
const SHUTDOWN_GRACE_MS = 3_000;
/** 收尾时最后一份数据到现在超时时长 */
const TAIL_SILENCE_MIN_MS = 5_000;

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

interface ActiveSession {
  recordingId: string;
  roomId: string;
  streamSessionId: string | null;
  stopRequested: boolean;
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
}

interface PreviewSession {
  engine: import("../recorder/engine.js").RecordingEngine;
  done: Promise<void>;
  recording: SharedPreviewRecording | null;
  /** 仅供没有可复用 bootstrap 时走旧交接路径。 */
  transitioningToRecording: boolean;
}

interface SharedPreviewRecording {
  session: ActiveSession;
  writer: WriteStream;
  normalizer: FlvTimestampNormalizer;
  pendingWrites: Buffer[];
  pendingWriteBytes: number;
  writePump: Promise<void> | null;
  writeError: Error | null;
}

export class RecorderManager {
  private active = new Map<string, ActiveSession>();
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

  /** 待确认保留的录制 → 超时自动保留定时器（#220）。 */
  private confirmTimers = new Map<string, unknown>();
  /** 正在转 MP4 的录制；分段收尾与录制完成可能各触发一次，必须避免两个 ffmpeg 抢同一份产物。 */
  private remuxJobs = new Set<string>();
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
  ) {}

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

  isPreviewStreaming(roomId: string): boolean {
    return this.previewSessions.has(roomId);
  }

  async enableHighlightBuffer(roomId: string): Promise<{
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  }> {
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
      const bootstrap = this.preview?.recordingBootstrap?.(roomId);
      if (bootstrap) buffer.append(bootstrap);
    } else {
      buffer.setRetainSeconds(settings.highlightBufferSeconds ?? 300);
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

  async disableHighlightBuffer(roomId: string): Promise<void> {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer) return;
    this.highlightBuffers.delete(roomId);
    await buffer.clear();
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
      await rename(rec.filePath, nextPath);
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
    if (this.services.resetting) return;
    if (
      this.previewSessions.has(roomId) ||
      this.previewTransitions.has(roomId) ||
      this.active.has(roomId)
    )
      return;
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== "live") return;
    try {
      const settings = this.settings();
      const cookie = await this.services.platformCookie(room.platform);
      const stream = await this.services
        .adapterFor(room.platform)
        .getStreamUrl(room.url, settings.quality, cookie);
      // getStreamUrl 期间可能已经点击了录制；二次检查避免迟到的 preview-only 流覆盖录制流。
      if (
        this.services.resetting ||
        !this.services.rooms.get(roomId) ||
        this.previewSessions.has(roomId) ||
        this.previewTransitions.has(roomId) ||
        this.active.has(roomId)
      )
        return;
      const engine = this.services.engineFor();
      const session: PreviewSession = {
        engine,
        done: Promise.resolve(),
        recording: null,
        transitioningToRecording: false,
      };
      this.previewSessions.set(roomId, session);
      session.done = (async () => {
        let streamError: ErrorObject | null = null;
        try {
          const input = {
            url: stream.url,
            format: stream.format,
            ...(stream.headers ? { headers: stream.headers } : {}),
          };
          for await (const event of engine.start(input, null)) {
            if (event.type === "data") {
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
                  await this.failRecording(
                    room,
                    sharedRecording.session.recordingId,
                    writeFailure(error, {
                      roomId,
                      recordingId: sharedRecording.session.recordingId,
                    }).toObject(),
                    "recorder",
                    true,
                  );
                }
              }
              if (this.settings().highlightEnabled !== false)
                this.highlightBuffers.get(roomId)?.append(event.chunk);
              this.preview?.broadcastFrame(roomId, event.chunk);
            }
            if (event.type === "error") {
              streamError = event.error;
              break;
            }
          }
        } catch (err) {
          // 预览拉流异常：预览本身静默收束（前端自己重连），但若挂着共享录制，原因要留给下面的接力判定。
          streamError =
            err instanceof AppError
              ? err.toObject()
              : (streamError ??
                new AppError("NETWORK_UNAVAILABLE", "预览拉流中断", {
                  roomId,
                  retryable: true,
                }).toObject());
        } finally {
          // 只允许当前会话清理自己，避免旧拉流的 finally 误删后来创建的新会话。
          if (this.previewSessions.get(roomId) === session)
            this.previewSessions.delete(roomId);
          let sharedRecording = session.recording;
          // 录制已交回普通路径继续时，这里的预览房间不能收：观看端还连着，
          // 收掉会把它的 FLV 初始化段一并删掉，之后重连永远起不来（画面卡在断网前那一秒）。
          // 收尾交给录制生命周期——录制真结束时 completeRecording 会带正确原因关闭房间。
          let handedOver = false;
          if (sharedRecording) {
            session.recording = null;
            let flushed = true;
            try {
              await this.closeSharedPreviewRecording(sharedRecording);
            } catch (error) {
              flushed = false;
              sharedRecording.writer.destroy();
              await this.failRecording(
                room,
                sharedRecording.session.recordingId,
                writeFailure(error, {
                  roomId,
                  recordingId: sharedRecording.session.recordingId,
                }).toObject(),
                "recorder",
                true,
              );
            }
            // 上游结束不再直接把录制收尾（那会丢掉重试机会、也不记录任何原因）：
            // 把会话交回普通录制路径，由它决定"还在播就续录、真下播就正常收尾、重试用尽才中断"。
            // 退出中不接力：写流已落盘，记录状态交给下次启动的恢复流程统一收口。
            if (flushed && !this.shuttingDown) {
              handedOver = true;
              const activeSession = sharedRecording.session;
              activeSession.segments = Math.max(1, activeSession.segments);
              activeSession.timestampOffsetMs = Math.max(
                activeSession.timestampOffsetMs,
                sharedRecording.normalizer.lastTimestampMs,
              );
              if (streamError) {
                await this.handleDisconnect(
                  room,
                  activeSession.recordingId,
                  streamError,
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
    } catch {
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
    // 点击录制后，预览拉流会被复用为录制数据源。此时最后一个预览客户端
    // 断开只表示弹窗已关闭，不能停止上游流，否则会把正在写入的录制直接收尾。
    // transitioningToRecording 是旧交接路径的显式停止，必须仍然允许执行。
    if (session.recording && !transitioningToRecording) return;
    if (transitioningToRecording) session.transitioningToRecording = true;
    await session.engine.stop().catch(() => undefined);
    await session.done.catch(() => undefined);
    // WebSocket 可能因 mpegts.js 的短暂重连而一度变成“最后一个客户端断开”。
    // 不能在这里清理精彩时刻缓存，否则播放器重连成功后缓存已丢失且前端不会重新启用。
    // 普通观看窗口卸载、关闭总开关、开始实时录制和服务重置会显式清理它。
  }

  private appendSharedPreviewRecording(
    recording: SharedPreviewRecording,
    chunk: Buffer,
  ): void {
    if (recording.writeError) throw recording.writeError;
    // FlvTimestampNormalizer 会原地改写时间戳；写盘必须处理副本，不能污染仍要
    // 广播给 mpegts 的原始预览帧，否则预览时间轴会在开始录制时跳回 0。
    for (const part of recording.normalizer.push(Buffer.from(chunk))) {
      if (
        recording.pendingWriteBytes + part.length >
        MAX_SHARED_RECORDING_PENDING_BYTES
      ) {
        throw new Error("录制磁盘写入过慢");
      }
      recording.session.size += part.length;
      recording.pendingWrites.push(part);
      recording.pendingWriteBytes += part.length;
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
        throw new Error("录制磁盘写入过慢");
      }
      recording.session.size += remaining.length;
      recording.pendingWrites.push(remaining);
      recording.pendingWriteBytes += remaining.length;
    }
    this.startSharedWritePump(recording);
    while (recording.writePump) await recording.writePump;
    if (recording.writeError) throw recording.writeError;
    await new Promise<void>((resolve, reject) => {
      recording.writer.once("error", reject);
      recording.writer.end(() => resolve());
    });
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
    let filePath: string;
    try {
      filePath = recordingFilePath(
        settings.recordingDirectory,
        room.platform,
        room.displayName || room.id,
        recording.startedAt,
        settings.recordingFormat,
        settings.namingRule,
        actualQuality,
        room.id,
      );
      await mkdir(path.dirname(filePath), { recursive: true });
    } catch (error) {
      // 已经落了记录就必须收尾：留着 pending 记录会让「录制中」计数虚增并占用并发名额。
      const err =
        error instanceof AppError
          ? error
          : new AppError(
              "RECORDING_DIRECTORY_INVALID",
              "保存目录无效，录制失败",
              { roomId: room.id, recordingId: recording.id },
            );
      const failed = this.services.recordings.update(recording.id, {
        state: "failed",
        endedAt: this.services.clock.iso(),
        failureReason: err.toObject(),
      });
      this.services.events.emit({ type: "recording:updated", data: failed });
      throw err;
    }
    const writer = createWriteStream(filePath);
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
      // 预览流的时间戳从打开观看起计算；录制文件须在本次开始处重新归零。
      normalizer: new FlvTimestampNormalizer({ rebaseFromFirstMedia: true }),
      pendingWrites: [],
      pendingWriteBytes: 0,
      writePump: null,
      writeError: null,
    };

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

  /**
   * 录制开始前的保存目录可用性检查（与 /settings/validate-directory 同口径）。
   * 必须在创建录制记录之前失败：目录无效时若先落一条 pending 记录，
   * 「录制中」计数会随每次点击累加，还会持续占用并发名额导致后续无法录制。
   */
  private async assertRecordingDirectoryUsable(
    directory: string,
    roomId: string,
  ): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
      const probe = path.join(directory, `.lr-probe-${ulid()}`);
      await writeFile(probe, "x", { flag: "wx" });
      await unlink(probe);
    } catch {
      throw new AppError(
        "RECORDING_DIRECTORY_INVALID",
        "保存目录无效，录制失败",
        { roomId },
      );
    }
  }

  /** 调度器发现直播后调用：并发上限、本次开播周期去重、磁盘保护，然后启动录制。manual=手动触发，可在本次直播中显式重录。 */
  async maybeStartRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    opts: {
      manual?: boolean;
      liveStartedAt?: string | null;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
  ): Promise<boolean> {
    if (this.services.resetting) return false;
    if (this.active.has(room.id) || this.starting.has(room.id)) return false;
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
      return false;
    }
    this.starting.add(room.id);
    try {
      return await this.maybeStartRecordingInternal(room, status, opts);
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
      liveStartedAt?: string | null;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
  ): Promise<boolean> {
    await this.disableHighlightBuffer(room.id);
    const settings = this.settings();
    const sessionId = status.streamSessionId ?? null;
    if (
      !opts.manual &&
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
      return false;
    }

    if (settings.recordingDirectory.length > 0) {
      await this.assertRecordingDirectoryUsable(
        settings.recordingDirectory,
        room.id,
      );
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

    const cookie = await this.services.platformCookie(room.platform);
    const stream = await this.services
      .adapterFor(room.platform)
      .getStreamUrl(room.url, settings.quality, cookie);
    // The stream lookup is asynchronous. A scheduler/manual request may have
    // claimed this room while it was in flight; never create a second session
    // or report a successful manual start in that case.
    if (this.active.has(room.id)) return false;
    // 已有观看预览时复用它的上游流；只有尚未形成可写入的关键帧缓存时才回退旧路径。
    if (
      await this.startSharedPreviewRecording(
        room,
        status,
        stream.actualQuality,
        settings,
        opts.origin ?? (opts.manual ? "manual" : "automatic"),
      )
    )
      return true;
    this.previewTransitions.add(room.id);
    try {
      // 无观看预览时维持原有独立录制路径。
      await this.stopPreviewStream(room.id, true);
      if (this.active.has(room.id)) return false;
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
    // 本次拉流的代次：代次由接过接力的那一路（resumeSession）推进，被取代的旧会话据此停止处理事件。
    const generation = session.generation;
    session.engine = engine;
    session.filePath = filePath;
    this.services.rooms.setState(room.id, "recording");
    // 只有真正新开一场录制时才清空预览头缓冲（跨录制不残留旧头，QA #150）。
    // 续录不能清：续录段会跳过 FLV 头（文件里已有），清了之后头再也补不回来，
    // 中途打开预览的观众会收不到初始化段（预览起不来、从预览点录制也会退化成另开一路拉流）。
    if (session.segments === 0) this.preview?.resetRoom(room.id);

    let startedConfirmed = false;
    // 「拿不到数据」的判据是收到第一份数据，而不是文件被创建：
    // 平台返回 200 后卡住不吐字节时 file_created 会先触发，只看它就会把这种情况判定成"已开始录"，一直挂到天荒地老。
    let gotData = false;
    const pendingTimeout = this.services.clock.setTimeout(() => {
      if (!gotData) {
        // 拿不到数据与断流是同一件事：同样进入重试，而不是一次判死（网络慢时白丢一次录制）。
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
            }
            session.size += event.chunk.length;
            const now = this.services.clock.now();
            // 恢复后拿到第一份数据：把中断期间的缺失时长结算到本次录制上。
            if (session.gapStartAt !== null) {
              session.missingMs += Math.max(0, now - session.gapStartAt);
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
          endReason: "stopped",
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

    // 写盘类失败与网络无关，重试没有意义：直接收尾，不让用户空等一轮退避。
    if (error.retryable === false) {
      await this.finishInterrupted(room, recordingId, humanizeFailure(error));
      return;
    }

    const settings = this.settings();
    // 起始重连额度：稳定录满 STABLE_RESET_MS 后归还——几小时前的旧故障不该拖累现在这一次抖动。
    let effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    let cause = error;

    // 退避重试循环：探测不到确定结论（网络错误/受限）或取流失败都只是"这一次没接上"，
    // 消耗一次额度后继续等下一轮，只有额度耗尽才收尾。绝不能把"没探测成功"当成"主播下播"——
    // 那会在网络抖动时把一次好录制无声结束掉。
    for (;;) {
      const recording = this.services.recordings.update(recordingId, {
        state: "reconnecting",
        retryCount: effective,
      });
      this.services.rooms.setState(room.id, "reconnecting");
      this.services.events.emit({ type: "recording:updated", data: recording });

      const delay = settings.retry.delaysSeconds[effective];
      if (delay === undefined || effective >= settings.retry.maxAttempts) {
        await this.finishInterrupted(
          room,
          recordingId,
          reconnectExhausted(cause, settings.retry.maxAttempts),
        );
        return;
      }
      this.raiseAlert(
        "warning",
        "recorder",
        new AppError(
          cause.code,
          `${causeLabel(cause.code)}，正在自动重试（第 ${effective + 1} 次）`,
          { roomId: room.id, recordingId, retryable: true },
        ),
      );

      await new Promise<void>((resolve) => {
        this.services.clock.setTimeout(() => resolve(), delay * 1000);
      });
      // 退避期间用户点了停止：按手动停止收尾。直接 return 会把记录永远留在"重连中"、占着并发名额，
      // 停止录制的请求也会一直挂在 session.done 上（唯一的出口是重启服务）。
      if (this.active.get(room.id)?.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, "ended", {
          endReason: "stopped",
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
        if (!cur) return;
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
    if (size > 0) {
      await this.completeRecording(room, recordingId, size, "stream_lost", {
        preservePreview,
        endReason: "interrupted",
        failure: err.toObject(),
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
      err.toObject(),
      "recorder",
      preservePreview,
    );
  }

  async stopRecording(roomId: string): Promise<void> {
    const session = this.active.get(roomId);
    if (!session) return;
    session.stopRequested = true;
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
          { preservePreview: true, endReason: "stopped" },
        );
        // 弹窗已关闭时共享上游流仍会为录制持续到这里；录制结束后没有观看者就收掉它。
        if (!this.preview?.hasClients(roomId))
          await this.stopPreviewStream(roomId);
      } catch (error) {
        sharedRecording.writer.destroy();
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
        endReason: "stopped",
      });
      return;
    }
    const settings = this.settings();
    if (endTimestampMs > session.timestampOffsetMs)
      session.timestampOffsetMs = endTimestampMs;
    if (session.gapStartAt === null)
      session.gapStartAt = session.lastDataAt || this.services.clock.now();
    const effective =
      this.services.clock.now() - session.lastRecoveryAt >= STABLE_RESET_MS
        ? 0
        : attempt;
    if (effective >= settings.retry.maxAttempts) {
      await this.completeRecording(room, recordingId, size, "ended");
      return;
    }
    const rapid =
      settings.retry.delaysSeconds[effective] ?? settings.retry.maxAttempts;
    // 短暂退避后重拉流：连续断连时避免高频空转，正常重连 gap 远小于调度器间隔。
    await new Promise<void>((resolve) => {
      this.services.clock.setTimeout(
        () => resolve(),
        Math.min(rapid, 5) * 1000,
      );
    });
    if (this.active.get(room.id)?.stopRequested) {
      await this.completeRecording(room, recordingId, size, "ended", {
        endReason: "stopped",
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
      if (!cur) return;
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
    this.finishOrConfirm(recordingId);
  }

  /**
   * 分段完成收尾入口（#220）：设置「完成后询问是否保留」开启时，录制完成进入待确认态并挂起
   * 管线/上传（由保留/不保留/超时/重启决定）；关闭时按原流程立即执行分段级收尾。
   */
  private finishOrConfirm(recordingId: string): void {
    const recording = this.services.recordings.get(recordingId);
    if (
      this.settings().confirmAfterComplete &&
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
   * 保留决策（#220）：恢复管线+上传（等价于原分段级收尾）。清除超时定时器；
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
    // 精彩时刻的确认框会在缓存文件复制完成前出现。超时默认保留也必须等
    // 导出完成，否则会把一个尚不存在的 filePath 交给后处理管线。
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

  /** 不保留决策（#220）：删除文件 + 删除录制记录，并清除超时定时器。 */
  discardAfterConfirmation(recordingId: string): void {
    this.clearConfirmTimer(recordingId);
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (rec.filePath) void unlink(rec.filePath).catch(() => undefined);
    this.services.recordings.remove(recordingId);
    this.services.events.emit({
      type: "recording:deleted",
      data: { id: recordingId },
    });
  }

  /** 启动恢复（#220）：上次运行遗留的待确认录制按「默认保留」恢复管线/上传。 */
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
   * 分段级收尾（分段完成/录制完成共用）：异步完整性校验 + 管线入队（未启用时触发上传）+ mp4_after 转封装。
   * 断流续录的中间分段也必须走这里，否则中间分段永远停在 .flv、也不会上传（PrePan：完成后转 MP4 不可用）。
   */
  private finishSegmentProcessing(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (rec.filePath) this.verifyIntegrity(rec);
    // mp4_after（且管线未启用）：先完成 FLV→MP4 转封装再入队管线/上传——
    // 避免上传抢在转封装前按旧 filePath 把 FLV 传走（PrePan：偶现转 mp4 失败上传的却是 flv）。
    if (
      this.settings().recordingFormat === "mp4_after" &&
      rec.filePath &&
      !this.services.pipeline.pipelineConfig().enabled
    ) {
      this.backgroundTasks += 1;
      void (async () => {
        const updated = await this.remuxToMp4(rec);
        this.services.events.emit({
          type: "recording:updated",
          data: updated ?? this.services.recordings.get(recordingId)!,
        });
        this.services.pipeline.enqueue(recordingId);
      })().finally(() => {
        this.backgroundTasks -= 1;
      });
      return;
    }
    // 后处理管线（V5 Batch2 #114）：enabled 时入队（verify/sidecar/cover/segment/compress/archive）；未启用时触发上传。
    this.services.pipeline.enqueue(recordingId);
  }

  /** mp4_after 格式：录制完成后 ffmpeg remux FLV→MP4，更新 filePath；失败保留 FLV 不阻断。返回更新后的记录。
   *  #225：中断/失败自动重试 2 次，仍失败则告警，让用户知道上传的将是 FLV，不静默。 */
  private async remuxToMp4(
    rec: import("../types/index.js").Recording,
  ): Promise<import("../types/index.js").Recording | null> {
    // 同一录制会被分段收尾与录制完成各触发一次：转封装进行中或已转好都跳过，避免重复告警和两个 ffmpeg 抢同一份产物。
    if (this.remuxJobs.has(rec.id) || !mp4PathFor(rec.filePath ?? ""))
      return null;
    this.remuxJobs.add(rec.id);
    try {
      const MAX_REMUX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_REMUX_RETRIES; attempt += 1) {
        try {
          const mp4 = await remuxFlvToMp4(rec.filePath!);
          if (mp4)
            return this.services.recordings.update(rec.id, { filePath: mp4 });
        } catch {
          // 尝试下一次
        }
        if (attempt < MAX_REMUX_RETRIES) {
          await new Promise<void>((resolve) =>
            this.services.clock.setTimeout(resolve, 1_000),
          );
        }
      }
      // 重试用尽：告警 + 记录标记，用户能知道上传的是 FLV（不静默）。
      this.raiseAlert(
        "warning",
        "recorder",
        new AppError(
          "RECORDING_REMUX_FAILED",
          "转 MP4 失败（已重试），将保留并上传源 FLV",
          { recordingId: rec.id, roomId: rec.roomId, retryable: false },
        ),
      );
      // 转封装失败并不等于录制失败，过去它只显示在告警中心，用户很容易错过。
      // 复用“录制失败”通知偏好，避免额外增加一项默认关闭的通知开关。
      const room = this.services.rooms.get(rec.roomId);
      if (room) {
        await this.notifier.notify("recording_remux_failed", room.id, {
          title: room.displayName,
        });
      }
      return null;
    } finally {
      this.remuxJobs.delete(rec.id);
    }
  }

  /** ffprobe 异步校验录制文件：verified/failed/pending（缺 ffprobe 或超时），failed 发告警。 */
  private verifyIntegrity(rec: import("../types/index.js").Recording): void {
    this.backgroundTasks += 1;
    void (async () => {
      try {
        const integrity = await checkFileIntegrity(rec.filePath!);
        // 服务可能已关闭（DB 关闭），吞掉该场景错误避免未处理拒绝。
        const updated = this.services.recordings.update(rec.id, { integrity });
        this.services.events.emit({ type: "recording:updated", data: updated });
        if (integrity === "failed") {
          this.raiseAlert(
            "warning",
            "recorder",
            new AppError(
              "RECORDING_FILE_CORRUPTED",
              "录制文件校验失败，可能损坏或截断",
              { recordingId: rec.id, roomId: rec.roomId, retryable: false },
            ),
          );
        }
      } catch {
        // 应用关闭/校验中途异常：忽略（完整性校验非关键路径）。
      }
    })().finally(() => {
      this.backgroundTasks -= 1;
    });
  }

  private async failRecording(
    room: Room,
    recordingId: string,
    err: ErrorObject,
    source: string,
    preservePreview = false,
  ): Promise<void> {
    // 退出中：同上，只放掉会话（记录留给恢复流程，避免退出时写库/发邮件）。
    if (this.shuttingDown) {
      this.active.get(room.id)?.resolveDone?.();
      this.active.delete(room.id);
      return;
    }
    const session = this.active.get(room.id);
    // 用户看到的原因必须是"人话"：技术性 message 换成对应场景的说明，原文留在 details 里备查。
    const failure = humanizeFailure(err);
    const rec = this.services.recordings.update(recordingId, {
      state: "failed",
      endedAt: this.services.clock.iso(),
      failureReason: failure.toObject(),
    });
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
