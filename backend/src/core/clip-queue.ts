import type { Services } from "./services.js";
import type { ClipQueueItem } from "../db/repositories/clip-queue.repo.js";
import { AppError } from "../types/error.js";
import { sanitizeRenameBase } from "../storage/file-organizer.js";
import { validateClipName } from "./recorder-manager.js";
import { recordedSeconds, assertSegmentRange } from "./recording-range.js";

/** Persistent task snapshots; markers are never consumed by submission. */
export class ClipQueueManager {
  private active = new Map<
    string,
    { abort: AbortController; job: Promise<void> }
  >();
  private stopping = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly services: Services) {}
  private get repo() {
    return this.services.clipQueue;
  }
  async submit(
    recordingId: string,
    markerIds: string[],
    requestId: string,
  ): Promise<string> {
    const old = this.repo.findBatch(recordingId, requestId);
    if (old) return old;
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !["recording", "reconnecting", "completed"].includes(rec.state))
      throw new AppError("RECORDING_NOT_AVAILABLE", "录像当前不可导出", {
        recordingId,
      });
    const duration = await recordedSeconds(this.services, rec);
    // Read after awaiting duration so edits/deletions cannot race validation.
    const markers = markerIds.map((id) => {
      const marker = this.services.recordingMarkers.get(recordingId, id);
      if (!marker || marker.endPositionSeconds == null)
        throw new AppError("CONFIG_INVALID", "请选择已保存的片段", {
          recordingId,
          details: { markerId: id },
        });
      assertSegmentRange(
        marker.positionSeconds,
        marker.endPositionSeconds,
        duration,
        recordingId,
      );
      return marker;
    });
    const mode = this.services.settings.load()?.encodingMode ?? "auto";
    const batch = this.repo.createBatch(recordingId, requestId, markers, mode);
    this.emit(recordingId);
    this.pump();
    return batch;
  }
  async submitRange(recordingId: string, start: number, end: number, name: string, requestId: string): Promise<string> {
    const old = this.repo.findBatch(recordingId, requestId);
    if (old) return old;
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !["recording", "reconnecting", "completed"].includes(rec.state))
      throw new AppError("RECORDING_NOT_AVAILABLE", "录像当前不可导出", { recordingId });
    const fileName = validateClipName(name, recordingId);
    assertSegmentRange(start, end, await recordedSeconds(this.services, rec), recordingId);
    const mode = this.services.settings.load()?.encodingMode ?? "auto";
    const batch = this.repo.createBatch(recordingId, requestId, [{
      id: null, positionSeconds: start, endPositionSeconds: end, text: fileName,
    }], mode);
    this.emit(recordingId);
    this.pump();
    return batch;
  }
  pump(): void {
    if (this.stopping || this.wakeTimer) return;
    while (this.active.size < 2) {
      const item = this.repo.nextQueued();
      if (!item) break;
      if (!this.services.manager.canStartClipExport()) {
        if (!this.wakeTimer) {
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.pump();
          }, 500);
          this.wakeTimer.unref();
        }
        break;
      }
      const abort = new AbortController();
      this.repo.setState(item.id, "running", {
        attemptsInc: true,
        error: null,
        outputRecordingId: null,
        actualEncoder: null,
        fallbackReason: null,
      });
      // Reserve the slot before execute reaches its first await.
      const slot = { abort, job: Promise.resolve() };
      this.active.set(item.id, slot);
      slot.job = this.execute(item, abort).finally(() => {
        this.active.delete(item.id);
        this.pump();
      });
    }
  }
  private async execute(
    item: ClipQueueItem,
    abort: AbortController,
  ): Promise<void> {
    this.emit(item.recordingId);
    try {
      const result = await this.services.manager.exportClip(
        item.recordingId,
        item.startSecond,
        item.endSecond,
        sanitizeRenameBase(item.fileName)
          .replace(/[\u0000-\u001f]/g, "_")
          .trim() || "片段",
        {
          allowCompleted: true,
          awaitCompletion: true,
          encodeMode: item.encodePolicy.encodingMode,
          signal: abort.signal,
          onCreated: (clipId) => {
            this.repo.setState(
              item.id,
              abort.signal.aborted ? "cancelling" : "running",
              { outputRecordingId: clipId },
            );
            this.emit(item.recordingId);
          },
        },
      );
      if (!this.repo.get(item.id)) return;
      if (abort.signal.aborted)
        this.repo.setState(
          item.id,
          this.stopping ? "interrupted" : "cancelled",
          { error: this.stopping ? "程序退出中断" : "已取消" },
        );
      else
        this.repo.setState(item.id, "done", {
          actualEncoder: result.clip.metadata?.actualEncoder ?? null,
          fallbackReason: result.clip.metadata?.fallbackReason ?? null,
        });
    } catch (error) {
      if (!this.repo.get(item.id)) return;
      if (
        !abort.signal.aborted &&
        error instanceof AppError &&
        error.code === "CONCURRENT_LIMIT_REACHED"
      ) {
        this.repo.setState(item.id, "queued", { error: null });
        if (!this.wakeTimer) {
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.pump();
          }, 500);
          this.wakeTimer.unref();
        }
        this.emit(item.recordingId);
        return;
      }
      this.repo.setState(
        item.id,
        abort.signal.aborted
          ? this.stopping
            ? "interrupted"
            : "cancelled"
          : "failed",
        {
          error: abort.signal.aborted
            ? this.stopping
              ? "程序退出中断"
              : "已取消"
            : error instanceof Error
              ? error.message
              : String(error),
        },
      );
    }
    this.emit(item.recordingId);
  }
  cancel(id: string): void {
    const item = this.repo.get(id);
    if (!item || !["queued", "running", "cancelling"].includes(item.state))
      return;
    const slot = this.active.get(id);
    if (slot) {
      this.repo.setState(id, "cancelling");
      slot.abort.abort();
    } else this.repo.setState(id, "cancelled", { error: "已取消" });
    this.emit(item.recordingId);
  }
  cancelPending(batchId: string): void {
    for (const item of this.repo.list(undefined, batchId)) this.cancel(item.id);
  }
  retry(id: string): void {
    const item = this.repo.get(id);
    if (
      !item ||
      !["failed", "interrupted", "cancelled"].includes(item.state) ||
      this.active.has(id)
    )
      return;
    this.repo.setState(id, "queued", { error: null });
    this.emit(item.recordingId);
    this.pump();
  }
  async removeByRecording(recordingId: string): Promise<void> {
    const items = this.repo.list(recordingId);
    for (const item of items) this.cancel(item.id);
    await Promise.all(items.map((item) => this.active.get(item.id)?.job));
    this.repo.deleteByRecording(recordingId);
    this.emit(recordingId);
  }
  reconcileOnBoot(): void {
    this.repo.reconcileOnBoot();
    this.pump();
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    for (const slot of this.active.values()) slot.abort.abort();
    await Promise.all([...this.active.values()].map((slot) => slot.job));
  }
  private emit(recordingId: string): void {
    this.services.events.emit({
      type: "clip-queue:updated",
      data: { recordingId },
    });
  }
}
