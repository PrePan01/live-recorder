import type { FastifyInstance } from 'fastify';
import type { Services } from '../../core/services.js';
import type { PipelineRun } from '../../types/index.js';
import { compositeClipProgress } from '../../core/task-progress.js';

/**
 * 任务进度聚合（轻只读端点）：四类在途任务统一 DTO——
 * 片段导出 / 管线后处理（含归档步）/ 上传 / 诊断导出。
 * 完成即离在途扫描（展示宽限由前端负责，后端不存已读）；
 * 失败文案沿用既有人话契约（error 字段随行）。
 */

export type TaskKind = 'clip' | 'pipeline' | 'upload' | 'export';

export interface TaskItem {
  id: string;
  kind: TaskKind;
  title: string;
  state: string;
  /** 合成进度（0-100 单一连续轴不跳变）；clip 两相位固定权重：导出 0-40、后处理 40-100。 */
  progressPercent?: number;
  step?: string | null;
  etaSeconds?: number | null;
  error?: string | null;
  updatedAt: string;
}

export function registerTaskRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/tasks', async (_req, reply) => {
    const tasks: TaskItem[] = [];

    // 在途管线索引：供 clip 两相位合并与管线条目排除。
    const activeRuns = new Map<string, PipelineRun>();
    for (const run of services.pipeline.repo.listRunsByStatuses(['queued', 'running'])) {
      activeRuns.set(run.recordingId, run);
    }

    // ① 片段导出在途：载体=录制行（origin=clip，processing 即在途）。
    // 后处理相位合并进同一条卡（导出→后处理单卡连贯，其管线 run 不再单独出条）。
    for (const rec of services.recordings.list({ page: 1, pageSize: 50, state: 'processing' }).items) {
      if (rec.origin !== 'clip') continue;
      const exportPct = services.manager.clipExportProgress(rec.id) ?? undefined;
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
      tasks.push({
        id: rec.id,
        kind: 'clip',
        title: rec.streamTitle,
        state: exporting ? 'exporting' : 'post_processing',
        progressPercent: composite,
        ...(exporting
          ? {}
          : {
              step: run!.progressStep ?? null,
              etaSeconds: run!.etaSeconds ?? null,
            }),
        error: rec.failureReason?.message ?? null,
        updatedAt: exporting ? rec.createdAt : (run!.heartbeatAt ?? run!.createdAt),
      });
    }

    // ② 管线在途（含归档步；进度四列在 run 行）——clip 的 run 已并入①，不单独出条。
    for (const run of activeRuns.values()) {
      const rec = services.recordings.get(run.recordingId);
      if (rec?.origin === 'clip') continue;
      tasks.push({
        id: run.id,
        kind: 'pipeline',
        title: rec?.streamTitle ?? '',
        state: run.status,
        ...(run.progressPct != null ? { progressPercent: run.progressPct } : {}),
        step: run.progressStep ?? null,
        etaSeconds: run.etaSeconds ?? null,
        updatedAt: run.heartbeatAt ?? run.createdAt,
      });
    }

    // ③ 上传在途。
    for (const job of services.uploader.uploadRepo.list({ limit: 100 })) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      const rec = services.recordings.get(job.recordingId);
      tasks.push({
        id: job.id,
        kind: 'upload',
        title: rec?.streamTitle ?? '',
        state: job.status,
        progressPercent: job.progress,
        error: job.error ?? null,
        updatedAt: job.updatedAt,
      });
    }

    // ④ 诊断/导出任务在途。
    for (const job of services.exporter.exportRepo.list({ limit: 50 })) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      const first = services.recordings.get(job.recordingIds[0] ?? '');
      tasks.push({
        id: job.id,
        kind: 'export',
        title:
          job.recordingIds.length > 1
            ? `${first?.streamTitle ?? '导出'} 等 ${job.recordingIds.length} 项`
            : (first?.streamTitle ?? '导出'),
        state: job.status,
        progressPercent: job.progress,
        error: job.error ?? null,
        updatedAt: job.updatedAt,
      });
    }

    return reply.send({ tasks });
  });
}
