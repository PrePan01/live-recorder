// 管理精彩时刻缓存、回溯导出，以及导出期间的取消和保留决定。
import { access, unlink } from "node:fs/promises";
import path from "node:path";
import { renameRecordingWithBuffer } from "../../recorder/buffered-writer.js";
import { HighlightBuffer } from "../../recorder/highlight-buffer.js";
import { finalizeYoutube } from "../../recorder/youtube-media.js";
import { recordingFilePath } from "../../storage/file-organizer.js";
import {
  moveMarkerSidecar,
  promoteMarkerSidecar,
} from "../../storage/recording-markers.js";
import { moveSeekIndexSidecar } from "../../storage/seek-index.js";
import { AppError } from "../../types/error.js";
import type { AppSettings } from "../../types/index.js";
import { failureText } from "../recording-failure.js";
import type { Services } from "../services.js";
import {
  HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS,
  HIGHLIGHT_EXPORT_WATCHDOG_REFRESH_MS,
} from "./constants.js";
import type { ActiveSession, PreviewSession, PreviewSink } from "./types.js";

interface HighlightControllerHost {
  readonly active: Map<string, ActiveSession>;
  settings(): AppSettings;
  readonly previewSessions: Map<string, PreviewSession>;
  readonly preview: PreviewSink | null;
  enterPendingConfirmation(recordingId: string): void;
  finishOrConfirm(recordingId: string, forceConfirm?: boolean): void;
  /**
   * 保留决策：恢复管线+上传（等价于原分段级收尾）。清除超时定时器；
   * 文件存在 → completed + 收尾；文件缺失 → failed（无法保留）。
   */
  resumeAfterConfirmation(recordingId: string): void;
  /** 不保留决策：删除文件 + 删除录制记录，并清除超时定时器。 */
  discardAfterConfirmation(recordingId: string): void;
  clearConfirmTimer(recordingId: string): void;
}

export class HighlightController {
  constructor(
    private services: Services,
    private host: HighlightControllerHost,
  ) {}
  /** Explicit normal-preview highlight caches. Live-wall clients never create these. */
  readonly highlightBuffers = new Map<string, HighlightBuffer>();

  readonly highlightQualities = new WeakMap<HighlightBuffer, string>();

  readonly highlightCleanup = new Map<string, Promise<void>>();

  /**
   * 精彩时刻导出期间提前展示的保留确认。导出可能需要等待当前缓存分段落盘，
   * 不能让这段 I/O 延迟阻塞确认框，也不能在文件尚未生成时启动后处理或删除记录。
   */
  readonly pendingHighlightConfirmations = new Map<
    string,
    { decision?: { keep: boolean; fileName?: string } }
  >();

  readonly highlightExportJobs = new Map<
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

  async enableHighlightBuffer(roomId: string): Promise<{
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  }> {
    await this.highlightCleanup.get(roomId)?.catch(() => undefined);
    if (this.host.active.has(roomId))
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
    const settings = this.host.settings();
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
      this.highlightQualities.set(
        buffer,
        this.host.previewSessions.get(roomId)?.actualQuality ??
          settings.quality,
      );
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
    const bootstrap = this.host.preview?.recordingBootstrap?.(roomId);
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
  maybeSeedHighlightBuffer(roomId: string): HighlightBuffer | undefined {
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

  detachHighlightBufferForRecording(roomId: string): void {
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
      maxSeconds: this.host.settings().highlightBufferSeconds ?? 300,
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
    if (this.host.active.has(roomId))
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "实时录制中无需使用精彩时刻",
        { roomId },
      );
    const room = this.services.rooms.get(roomId);
    const buffer = this.highlightBuffers.get(roomId);
    if (this.host.settings().highlightEnabled === false)
      throw new AppError("RECORDING_NOT_AVAILABLE", "精彩时刻功能未开启", {
        roomId,
      });
    if (!room || !buffer)
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "请先在普通观看窗口中等待精彩时刻缓存",
        { roomId },
      );
    const maxSeconds = this.host.settings().highlightBufferSeconds ?? 300;
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
    const settings = this.host.settings();
    const bufferedQuality =
      this.highlightQualities.get(buffer) ??
      this.host.previewSessions.get(roomId)?.actualQuality ??
      settings.quality;
    const recording = this.services.recordings.create({
      roomId,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: null,
      streamTitle: `精彩时刻｜${room.displayName}`,
      quality: bufferedQuality,
      expectedQuality: bufferedQuality,
      origin: "highlight",
    });
    const base = recordingFilePath(
      settings.recordingDirectory,
      room.platform,
      room.displayName || room.id,
      recording.startedAt,
      settings.recordingFormat,
      settings.namingRule,
      bufferedQuality,
      room.id,
    );
    const parsed = path.parse(base);
    const filePath = path.join(
      parsed.dir,
      `${parsed.name}_highlight_${recording.id}${room.platform === "youtube" ? ".flv" : parsed.ext}`,
    );
    const confirmAfterComplete = this.host.settings().confirmAfterComplete;
    if (confirmAfterComplete) {
      this.pendingHighlightConfirmations.set(recording.id, {});
      this.services.recordings.update(recording.id, {
        filePath,
        highlightExportPending: true,
        highlightConfirmationDecision: null,
        highlightConfirmationFileName: null,
      });
      this.host.enterPendingConfirmation(recording.id);
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
          this.host.finishOrConfirm(recording.id);
          this.finishHighlightExportJob(recording.id, job);
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
          this.host.resumeAfterConfirmation(recording.id);
        } else {
          this.host.discardAfterConfirmation(recording.id);
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
    this.host.clearConfirmTimer(recordingId);
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
    this.host.clearConfirmTimer(recordingId);
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

  async failHighlightExport(
    recordingId: string,
    roomId: string,
    filePath: string,
    error: unknown,
  ): Promise<void> {
    const job = this.highlightExportJobs.get(recordingId);
    if (job) job.settling = true;
    try {
      this.host.clearConfirmTimer(recordingId);
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
      if (rec.platform === "youtube")
        await finalizeYoutube(
          rec.filePath,
          this.services.recordingBufferDirectory,
        );
      await renameRecordingWithBuffer(
        this.services.recordingBufferDirectory,
        rec.filePath,
        nextPath,
      );
      await this.services.danmaku.moveSidecar(
        recordingId,
        rec.filePath,
        nextPath,
      );
      await moveMarkerSidecar(rec.filePath, nextPath);
      await moveSeekIndexSidecar(rec.filePath, nextPath);
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
}
