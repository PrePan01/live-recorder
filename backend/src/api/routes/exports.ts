import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

export function registerExportRoutes(app: FastifyInstance, services: Services): void {
  // 创建导出：body { recordingIds, baseDir }；单场或批量。
  app.post('/api/v1/exports', async (req, reply) => {
    const body = (req.body ?? {}) as { recordingIds?: unknown; baseDir?: unknown };
    if (!Array.isArray(body.recordingIds) || body.recordingIds.length === 0 || body.recordingIds.length > 100) {
      throw new AppError('CONFIG_INVALID', 'recordingIds 需为非空数组（≤100）');
    }
    if (typeof body.baseDir !== 'string' || body.baseDir.length === 0) {
      throw new AppError('CONFIG_INVALID', 'baseDir 必填（用户选择的导出目录）');
    }
    for (const id of body.recordingIds) {
      if (typeof id !== 'string') throw new AppError('CONFIG_INVALID', 'recordingIds 必须为字符串数组');
    }
    const job = await services.exporter.create(body.recordingIds as string[], body.baseDir);
    services.events.emit({ type: 'export:updated', data: job });
    return reply.status(201).send({ export: job });
  });

  // 导出详情。
  app.get('/api/v1/exports/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = services.exporter.exportRepo.get(id);
    if (!job) throw new AppError('RESOURCE_NOT_FOUND', '导出任务不存在', { details: { resource: 'export' } });
    return reply.send({ export: job });
  });

  // 导出列表。
  app.get('/api/v1/exports', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    return reply.send({ exports: services.exporter.exportRepo.list({ limit: Number(qs.limit ?? '100') }) });
  });

  // 取消。
  app.post('/api/v1/exports/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = services.exporter.cancel(id);
    if (!job) throw new AppError('RESOURCE_NOT_FOUND', '导出任务不存在', { details: { resource: 'export' } });
    services.events.emit({ type: 'export:updated', data: job });
    return reply.send({ export: job });
  });
}