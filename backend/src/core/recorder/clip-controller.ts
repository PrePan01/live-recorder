// 从已录录像导出片段，管理导出并发、进度、取消和文件收尾。
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { exportClipFile } from "../../recorder/pipeline-ffmpeg.js";
import {
  sanitizeRenameBase,
  uniqueTargetPath,
} from "../../storage/file-organizer.js";
import { AppError } from "../../types/error.js";
import { validateClipName } from "../clip-validation.js";
import { assertSegmentRange, recordedSeconds } from "../recording-range.js";
import type { Services } from "../services.js";
import { MAX_PARALLEL_CLIP_EXPORTS } from "./constants.js";

interface ClipExportControllerHost {
  readonly shuttingDown: boolean;
  finishSegmentProcessing(recordingId: string): void;
}

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
export class ClipExportController {
  constructor(
    private services: Services,
    private host: ClipExportControllerHost,
  ) {}
  /** 片段导出在途：`源录制id:起-止` → clip id（同选区防重复提交，不同选区可并行）。 */
  readonly clipExports = new Map<string, string>();

  /** clip id → 已推送的进度百分比（列表响应补「导出中 x%」用，终态清除）。 */
  readonly clipProgress = new Map<string, number>();

  /** 片段导出取消信号（删除联动：导出任务立即真停）。 */
  readonly clipExportAborts = new Map<string, AbortController>();

  readonly clipExportJobs = new Map<string, Promise<void>>();

  /** 片段导出进度快照（0-100）：导出进行中为数字，供历史列表显示「导出中 x%」。 */
  /** 删除联动：取消该片段的在途导出（立即真停，不留孤儿任务）。 */
  canStartClipExport(): boolean {
    return (
      !this.host.shuttingDown &&
      this.clipExports.size < MAX_PARALLEL_CLIP_EXPORTS
    );
  }

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
    opts: {
      /** 队列面放行：已完成录制的已录区间可导（停录不取消已提交的落地面）；直接 API 仍仅录中。 */
      allowCompleted?: boolean;
      /** 编码策略快照（队列提交时定格）；缺省=全局设置。 */
      encodeMode?: "auto" | "software";
      /** 队列路径：等导出链完成再返回（写点落定后 clip 行含编码面真值）。 */
      awaitCompletion?: boolean;
      signal?: AbortSignal;
      onCreated?: (clipId: string) => void;
    } = {},
  ): Promise<{
    source: import("../../types/index.js").Recording;
    clip: import("../../types/index.js").Recording;
  }> {
    let currentSource = this.services.recordings.get(recordingId);
    if (!currentSource)
      throw new AppError("RECORDING_NOT_AVAILABLE", "录像不存在", {
        recordingId,
      });
    const initialSource = currentSource;
    const sourceOk =
      initialSource &&
      (initialSource.state === "recording" ||
        initialSource.state === "reconnecting" ||
        (opts.allowCompleted &&
          ["completed", "processing", "awaiting_confirmation"].includes(
            initialSource.state,
          )));
    if (!sourceOk) {
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
    const elapsed = await recordedSeconds(this.services, initialSource);
    if (opts.allowCompleted) {
      currentSource = this.services.recordings.get(recordingId);
      if (!currentSource || !currentSource.filePath)
        throw new AppError("RECORDING_NOT_AVAILABLE", "录像文件不可读", {
          recordingId,
        });
    }
    const source = currentSource;
    if (opts.signal?.aborted)
      throw new AppError("RECORDING_NOT_AVAILABLE", "已取消", { recordingId });
    // Validation can await a duration probe; recheck the shared reservation afterwards.
    if (this.clipExports.has(selectionKey) || !this.canStartClipExport())
      throw new AppError("CONCURRENT_LIMIT_REACHED", "请等待其他片段导出完成", {
        recordingId,
      });
    assertSegmentRange(startSecond, endSecond, elapsed, recordingId);
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
    const externalAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", externalAbort, { once: true });
    if (opts.signal?.aborted) abort.abort();
    opts.onCreated?.(clip.id);
    const job = (async () => {
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
            signal: abort.signal,
            // 坑点：对象字面量后键胜——快照参数必须排在全局回退之后，否则执行层快照被覆盖。
            encodingMode: this.services.settings.load()?.encodingMode ?? "auto",
            ...(opts.encodeMode ? { encodingMode: opts.encodeMode } : {}),
            onEncoder: ({ actualEncoder, fallbackReason }) => {
              if (
                abort.signal.aborted ||
                !this.services.recordings.get(clip.id)
              )
                return;
              const row = this.services.recordings.update(clip.id, {
                metadata: {
                  ...(this.services.recordings.get(clip.id)?.metadata ?? {
                    durationMs: null,
                    segmentCount: 1,
                    quality: null,
                    size: 0,
                  }),
                  actualEncoder,
                  fallbackReason,
                },
              });
              this.services.events.emit({
                type: "recording:updated",
                data: row,
              });
            },
            onProgress: ({ outTimeMs }) => {
              if (abort.signal.aborted || this.host.shuttingDown) return;
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
        const current = this.services.recordings.get(clip.id);
        if (abort.signal.aborted || this.host.shuttingDown || !current) {
          await unlink(outputPath).catch(() => undefined);
          return;
        }
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
        const finalized = await withClipFinalizeLock(async () => {
          if (abort.signal.aborted || !this.services.recordings.get(clip.id))
            return null;
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
        if (
          !finalized ||
          abort.signal.aborted ||
          this.host.shuttingDown ||
          !this.services.recordings.get(clip.id)
        ) {
          await unlink(finalized?.landed ?? currentPath).catch(() => undefined);
          return;
        }
        const { landed, finalTitle } = finalized;
        this.services.recordings.update(clip.id, {
          state: "completed",
          // 导出结束只是后处理的交接点，校验队列也会发事件，先标记等待后处理。
          pipelineStatus: "queued",
          endReason: "clip_export",
          endedAt: new Date(
            Date.parse(source.startedAt) + endSecond * 1000,
          ).toISOString(),
          fileSizeBytes: result.sizeBytes,
          filePath: landed,
          // 编码面记账：任务显示实际编码方式与回退原因（设计第 3 项显示面）。元数据整替=先并后写。
          metadata: {
            ...(this.services.recordings.get(clip.id)?.metadata ?? {
              durationMs: null,
              segmentCount: 1,
              quality: null,
              size: 0,
            }),
            actualEncoder:
              (result as { actualEncoder?: string }).actualEncoder ?? null,
            fallbackReason:
              (result as { fallbackReason?: string | null }).fallbackReason ??
              null,
          },
          ...(finalTitle !== undefined ? { streamTitle: finalTitle } : {}),
        });
        this.clipProgress.delete(clip.id);
        // 校验与后处理与正常保存录像完全同链：自动入完整性校验队列 + 按配置自动进管线
        // （未启用管线时的 not_required+自动上传同语义），不依赖手动批量重校验。
        this.host.finishSegmentProcessing(clip.id);
        // 使用入队后的真实状态：启用管线时仍在 processing，未启用时 not_required。
        this.services.events.emit({
          type: "recording:updated",
          data: {
            ...this.services.recordings.get(clip.id)!,
            progressPercent: null,
          },
        });
      } catch (error) {
        await unlink(outputPath).catch(() => undefined);
        if (
          !abort.signal.aborted &&
          !this.host.shuttingDown &&
          this.services.recordings.get(clip.id)
        ) {
          const failed = this.services.recordings.update(clip.id, {
            state: "failed",
            failureReason: new AppError(
              "RECORDING_FILE_CORRUPTED",
              "片段导出失败",
              {
                recordingId: clip.id,
                details: { reason: String(error).slice(-200) },
              },
            ).toObject(),
          });
          this.services.events.emit({
            type: "recording:updated",
            data: { ...failed, progressPercent: null },
          });
        }
      } finally {
        // 解除在途占位；源录制全程不碰（导出不停录）。
        opts.signal?.removeEventListener("abort", externalAbort);
        this.clipExports.delete(selectionKey);
        this.clipExportAborts.delete(clip.id);
        this.clipExportJobs.delete(clip.id);
        this.clipProgress.delete(clip.id);
      }
    })();
    this.clipExportJobs.set(clip.id, job);
    this.services.events.emit({ type: "recording:updated", data: pending });
    if (opts.awaitCompletion) {
      // 队列路径：等导出链写点落定再返回（坑点：exportClip 交互路是火即忘——
      // 不 await 的调用方拿到的 clip 是写点前旧引用，编码面/终态都会失真）。
      await job;
      const settled = this.services.recordings.get(clip.id);
      if (
        abort.signal.aborted ||
        !settled ||
        settled.state === "failed" ||
        (settled.state === "processing" && !settled.endReason)
      ) {
        if (abort.signal.aborted && settled) {
          this.services.recordings.update(clip.id, {
            state: "failed",
            failureReason: new AppError(
              "RECORDING_NOT_AVAILABLE",
              "片段导出已取消",
              { recordingId: clip.id },
            ).toObject(),
          });
          this.services.events.emit({
            type: "recording:updated",
            data: this.services.recordings.get(clip.id)!,
          });
        }
        throw new AppError(
          "RECORDING_NOT_AVAILABLE",
          abort.signal.aborted
            ? "已取消"
            : (settled?.failureReason?.message ?? "片段导出失败"),
          { recordingId: clip.id },
        );
      }
      return {
        source: this.services.recordings.get(recordingId)!,
        clip: this.services.recordings.get(clip.id) ?? pending,
      };
    }
    return {
      source: this.services.recordings.get(recordingId)!,
      clip: pending,
    };
  }
}
