import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

export function registerPipelineRoutes(app: FastifyInstance, services: Services): void {
  // 录制后处理详情：run + artifacts 步骤时间线。
  app.get('/api/v1/recordings/:id/pipeline', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    const run = services.pipeline.repo.runForRecording(id);
    if (!run) return reply.send({ run: null });
    return reply.send({ run });
  });

  // 重试失败/部分成功的管线（新 run，快照当前配置）。
  app.post('/api/v1/recordings/:id/pipeline/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    if (!rec.filePath) throw new AppError('CONFIG_LOAD_FAILED', '录制无文件，无法重试管线', { recordingId: id });
    const result = services.pipeline.retry(id);
    if (!result.ok) {
      throw new AppError('CONFIG_LOAD_FAILED', '管线正在排队或运行中，无法重试', { recordingId: id });
    }
    return reply.send({ ok: true, run: result.run });
  });

  // 封面帧静态服务：有封面输出 jpg；无封面 404 占位。
  app.get('/api/v1/media/cover/:recordingId', async (req, reply) => {
    const { recordingId } = req.params as { recordingId: string };
    const rec = services.recordings.get(recordingId);
    if (!rec || !rec.coverPath) {
      throw new AppError('RESOURCE_NOT_FOUND', '封面不存在', { recordingId, details: { resource: 'cover' } });
    }
    let size: number;
    try {
      size = (await stat(rec.coverPath)).size;
    } catch {
      throw new AppError('RESOURCE_NOT_FOUND', '封面文件缺失', { recordingId, details: { resource: 'cover' } });
    }
    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(rec.coverPath));
  });
}