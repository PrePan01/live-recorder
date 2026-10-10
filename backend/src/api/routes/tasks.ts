import type { FastifyInstance } from "fastify";
import type { Services } from "../../core/services.js";
import type { PipelineRun } from "../../types/index.js";
import { compositeClipProgress } from "../../core/task-progress.js";

export type TaskKind = "clip" | "pipeline" | "upload" | "export";

export interface TaskItem {
  id: string;
  kind: TaskKind;
  recordingId?: string;
  title: string;
  state: string;
  progressPercent?: number;
  step?: string | null;
  etaSeconds?: number | null;
  error?: string | null;
  updatedAt: string;

  /** 实际编码方式（任务显示面），无编码语义的任务=null。 */
  actualEncoder?: string | null;
  /** 回退原因人话（未回退=null）。 */
  fallbackReason?: string | null;
}

export function registerTaskRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.get<{ Querystring: { ids?: string } }>(
    "/api/v1/tasks",
    async (req, reply) => {
      const tasks: TaskItem[] = [];

      // 在途管线索引：供 clip 两相位合并与管线条目排除。
      const activeRuns = new Map<string, PipelineRun>();
      for (const run of services.pipeline.repo.listRunsByStatuses([
        "queued",
        "running",
      ])) {
        activeRuns.set(run.recordingId, run);
      }

      // ① 片段导出在途：载体=录制行（origin=clip，processing 即在途）。
      // 后处理相位合并进同一条卡（导出→后处理单卡连贯，其管线 run 不再单独出条）。
      for (const rec of services.recordings.list({
        page: 1,
        pageSize: 50,
        state: "processing",
      }).items) {
        if (rec.origin !== "clip") continue;
        const exportPct =
          services.manager.clipExportProgress(rec.id) ?? undefined;
        const run = activeRuns.get(rec.id);
        const exporting = exportPct !== undefined || !run;
        // 动态 ETA 加权合成（0-100 连续、只进不退）：按实际存在相位的预计耗时占比实时合成，
        // 与历史行读同一函数（三处同源）；单相位（无导出/无后处理）铺满全量程、从 0 起步。
        const composite = compositeClipProgress({
          id: rec.id,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          createdAt: rec.createdAt,
          fileSizeBytes: rec.fileSizeBytes ?? 0,
          exportPct: exportPct ?? null,
          run: run ?? null,
          hasPostPhase: services.pipeline.pipelineConfig().enabled,
          now: Date.now(),
        });
        const clipMeta = (rec.metadata ?? {}) as { actualEncoder?: string | null; fallbackReason?: string | null };
        tasks.push({
          id: rec.id,
          kind: "clip",
          actualEncoder: clipMeta.actualEncoder ?? null,
          fallbackReason: clipMeta.fallbackReason ?? null,
          recordingId: rec.id,
          title: rec.streamTitle,
          state: exporting ? "exporting" : "post_processing",
          progressPercent: composite,
          ...(exporting
            ? {}
            : {
                step: run!.progressStep ?? null,
                etaSeconds: run!.etaSeconds ?? null,
              }),
          error: rec.failureReason?.message ?? null,
          updatedAt: exporting
            ? rec.createdAt
            : (run!.heartbeatAt ?? run!.createdAt),
        });
      }

      // ② 管线在途（含归档步；进度四列在 run 行）——clip 的 run 已并入①，不单独出条。
      for (const run of activeRuns.values()) {
        const rec = services.recordings.get(run.recordingId);
        if (rec?.origin === "clip") continue;
        const encArtifact = services.pipeline.repo
          .listArtifacts(run.id)
          .find((a) => a.actualEncoder);
        tasks.push({
          id: run.id,
          kind: "pipeline",
          actualEncoder: encArtifact?.actualEncoder ?? null,
          fallbackReason: encArtifact?.fallbackReason ?? null,
          recordingId: run.recordingId,
          title: rec?.streamTitle ?? "",
          state: run.status,
          ...(run.progressPct != null
            ? { progressPercent: run.progressPct }
            : {}),
          step: run.progressStep ?? null,
          etaSeconds: run.etaSeconds ?? null,
          updatedAt: run.heartbeatAt ?? run.createdAt,
        });
      }

      // ③ 上传在途。
      for (const job of services.uploader.uploadRepo.list({ limit: 100 })) {
        if (job.status !== "queued" && job.status !== "running") continue;
        const rec = services.recordings.get(job.recordingId);
        tasks.push({
          id: job.id,
          kind: "upload",
          title: rec?.streamTitle ?? "",
          state: job.status,
          progressPercent: job.progress,
          error: job.error ?? null,
          updatedAt: job.updatedAt,
        });
      }

      // ④ 诊断/导出任务在途。
      for (const job of services.exporter.exportRepo.list({ limit: 50 })) {
        if (job.status !== "queued" && job.status !== "running") continue;
        const first = services.recordings.get(job.recordingIds[0] ?? "");
        tasks.push({
          id: job.id,
          kind: "export",
          title:
            job.recordingIds.length > 1
              ? `${first?.streamTitle ?? "导出"} 等 ${job.recordingIds.length} 项`
              : (first?.streamTitle ?? "导出"),
          state: job.status,
          progressPercent: job.progress,
          error: job.error ?? null,
          updatedAt: job.updatedAt,
        });
      }

      // 默认仍只返回在途项。客户端携带已观察的 id，按主记录回查终态，
      // 不能把「离开在途扫描」误当成功，也不需要扫描全部历史任务。
      const activeIds = new Set(tasks.map((task) => task.id));
      const observedIds =
        typeof req.query.ids === "string"
          ? [...new Set(req.query.ids.split(","))].slice(0, 200)
          : [];
      const terminal = (task: TaskItem): TaskItem =>
        task.state === "completed"
          ? {
              ...task,
              progressPercent: 100,
              step: null,
              etaSeconds: null,
              error: null,
            }
          : { ...task, etaSeconds: null };
      for (const id of observedIds) {
        if (!id || activeIds.has(id)) continue;
        const rec = services.recordings.get(id);
        if (
          rec?.origin === "clip" &&
          (rec.state === "failed" ||
            (rec.state === "completed" &&
              rec.pipelineStatus !== "queued" &&
              rec.pipelineStatus !== "running"))
        ) {
          const state =
            rec.state === "failed" || rec.pipelineStatus === "failed"
              ? "failed"
              : rec.pipelineStatus === "partial"
                ? "partial"
                : "completed";
          tasks.push(
            terminal({
              id,
              kind: "clip",
              recordingId: id,
              title: rec.streamTitle,
              state,
              error:
                rec.failureReason?.message ??
                (state === "failed" ? "片段后处理失败" : null),
              updatedAt: new Date().toISOString(),
            }),
          );
          continue;
        }
        const run = services.pipeline.repo.getRun(id);
        if (run && ["ok", "partial", "failed"].includes(run.status)) {
          tasks.push(
            terminal({
              id,
              kind: "pipeline",
              recordingId: run.recordingId,
              title:
                services.recordings.get(run.recordingId)?.streamTitle ?? "",
              state: run.status === "ok" ? "completed" : run.status,
              ...(run.progressPct != null
                ? { progressPercent: run.progressPct }
                : {}),
              updatedAt: run.endedAt ?? run.heartbeatAt ?? run.createdAt,
            }),
          );
          continue;
        }
        const upload = services.uploader.uploadRepo.get(id);
        if (
          upload &&
          upload.status !== "queued" &&
          upload.status !== "running"
        ) {
          tasks.push(
            terminal({
              id,
              kind: "upload",
              title:
                services.recordings.get(upload.recordingId)?.streamTitle ?? "",
              state: upload.status === "ok" ? "completed" : upload.status,
              progressPercent: upload.progress,
              error: upload.error,
              updatedAt: upload.updatedAt,
            }),
          );
          continue;
        }
        const job = services.exporter.exportRepo.get(id);
        if (job && job.status !== "queued" && job.status !== "running") {
          tasks.push(
            terminal({
              id,
              kind: "export",
              title:
                services.recordings.get(job.recordingIds[0] ?? "")
                  ?.streamTitle ?? "导出",
              state: job.status === "ok" ? "completed" : job.status,
              progressPercent: job.progress,
              error: job.error,
              updatedAt: job.updatedAt,
            }),
          );
        }
      }
      return reply.send({ tasks });
    },
  );
}
