// 处理录像保留确认，并将已保存的录像交给校验、后处理和上传流程。
import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import {
  hasPendingRecordingBuffer,
  removeRecordingBuffer,
} from "../../recorder/buffered-writer.js";
import {
  finalizeYoutube,
  removeYoutubeParts,
  youtubeManifest,
} from "../../recorder/youtube-media.js";
import {
  promoteMarkerSidecar,
  removeMarkerSidecar,
} from "../../storage/recording-markers.js";
import { removeSeekIndexSidecar } from "../../storage/seek-index.js";
import { AppError } from "../../types/error.js";
import type { AppSettings } from "../../types/index.js";
import type { Services } from "../services.js";
import { KEEP_CONFIRM_TIMEOUT_MS } from "./constants.js";

interface RecordingCompletionHost {
  settings(): AppSettings;
  readonly pendingHighlightConfirmations: Map<
    string,
    { decision?: { keep: boolean; fileName?: string } }
  >;
  cancelClipExport(recordingId: string): void;
  failHighlightExport(
    recordingId: string,
    roomId: string,
    filePath: string,
    error: unknown,
  ): Promise<void>;
  readonly shuttingDown: boolean;
}

export class RecordingCompletion {
  constructor(
    private services: Services,
    private host: RecordingCompletionHost,
  ) {}
  /** 待确认保留的录制 → 超时自动保留定时器。 */
  readonly confirmTimers = new Map<string, unknown>();

  /**
   * 分段级收尾（分段完成/录制完成共用）：异步完整性校验 + 管线入队。
   */
  readonly youtubeFinalizations = new Set<string>();

  clearPendingConfirmations(): void {
    for (const id of this.confirmTimers.keys()) this.clearConfirmTimer(id);
  }

  /**
   * 分段完成收尾入口：设置「完成后询问是否保留」开启时，录制完成进入待确认态并挂起
   * 管线/上传（由保留/不保留/超时/重启决定）；关闭时按原流程立即执行分段级收尾。
   */
  finishOrConfirm(recordingId: string, forceConfirm = false): void {
    const recording = this.services.recordings.get(recordingId);
    if (
      (forceConfirm || this.host.settings().confirmAfterComplete) &&
      recording?.origin !== "floating"
    ) {
      this.enterPendingConfirmation(recordingId);
    } else {
      this.finishSegmentProcessing(recordingId);
    }
  }

  /** 录制完成进入待确认态：state=awaiting_confirmation，挂起管线/上传，并安排超时自动保留。 */
  enterPendingConfirmation(recordingId: string): void {
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
      this.host.pendingHighlightConfirmations.get(recordingId);
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
    this.host.cancelClipExport(recordingId);
    if (rec.filePath) {
      void this.services.danmaku
        .stopForRecording(recordingId)
        .then(() => this.services.danmaku.removeSidecar(rec.filePath))
        .catch(() => undefined);
      if (rec.platform === "youtube")
        void removeYoutubeParts(rec.filePath).catch(() => undefined);
      void unlink(rec.filePath).catch(() => undefined);
      void removeMarkerSidecar(rec.filePath);
      void removeSeekIndexSidecar(rec.filePath);
      void removeRecordingBuffer(
        this.services.recordingBufferDirectory,
        rec.filePath,
      ).catch(() => undefined);
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
          void this.host.failHighlightExport(
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

  clearConfirmTimer(recordingId: string): void {
    const handle = this.confirmTimers.get(recordingId);
    if (handle !== undefined) {
      this.services.clock.clearTimeout(handle);
      this.confirmTimers.delete(recordingId);
    }
  }

  finishSegmentProcessing(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (
      rec.platform === "youtube" &&
      rec.filePath &&
      existsSync(youtubeManifest(rec.filePath))
    ) {
      if (this.youtubeFinalizations.has(recordingId)) return;
      this.youtubeFinalizations.add(recordingId);
      void finalizeYoutube(rec.filePath, this.services.recordingBufferDirectory)
        .then(async () => {
          const size = (await stat(rec.filePath!)).size;
          this.youtubeFinalizations.delete(recordingId);
          if (this.host.shuttingDown) return;
          this.services.recordings.update(recordingId, {
            fileSizeBytes: size,
            failureReason: null,
          });
          this.finishSegmentProcessing(recordingId);
        })
        .catch(() => {
          this.youtubeFinalizations.delete(recordingId);
          if (!this.host.shuttingDown)
            this.services.recordings.update(recordingId, {
              pipelineStatus: "failed",
              failureReason: new AppError(
                "RECORDING_REMUX_FAILED",
                "YouTube 分段未合并，已保留原始内容，请重试处理",
              ).toObject(),
            });
        });
      return;
    }
    if (
      rec.filePath &&
      hasPendingRecordingBuffer(
        this.services.recordingBufferDirectory,
        rec.filePath,
      )
    ) {
      this.services.recordings.update(recordingId, {
        pipelineStatus: "failed",
      });
      console.warn(
        `[recording-recovery] ${recordingId} 暂存尚未补写，后处理与自动上传等待恢复`,
      );
      return;
    }
    if (rec.filePath) this.services.verificationQueue.enqueue(rec);
    // 保留即归位：标签数据从 .cache/ 搬到 标签/（无标签文件时为无操作）。
    if (rec.filePath) void promoteMarkerSidecar(rec.filePath);
    // 格式转换已是管线独立步骤；未启用管线时仍触发上传。
    this.services.pipeline.enqueue(recordingId);
  }
}
