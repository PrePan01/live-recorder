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
    const result = services.pipeline.retry(id, true);
    if (!result.ok) {
      // 409 而非 500：排队/运行中属冲突态（task #59，原 CONFIG_LOAD_FAILED→500 错误类）。
      throw new AppError('RECORDING_NOT_AVAILABLE', '管线正在排队或运行中，无法重试', { recordingId: id });
    }
    return reply.send({ ok: true, run: result.run });
  });

  // 启动/继续管线：中断或未跑过的录制只要有可用文件即可进入（与 retry 同语义，命名给「处理已录部分/继续处理」）。
  app.post('/api/v1/recordings/:id/pipeline/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    if (!rec.filePath) throw new AppError('CONFIG_LOAD_FAILED', '录制无文件，无法进入管线', { recordingId: id });
    const quick = await services.pipeline.quickMediaCheck(rec.filePath);
    if (!quick.ok) throw new AppError('CONFIG_LOAD_FAILED', `文件不可用，无法进入管线：${quick.reason ?? '未知原因'}`, { recordingId: id });
    // 三态语义：未跑过/failed=全新启动（retry 建新 run）；中断残留 queued/running=处理已录部分（断点续跑，异步推进立即返回）。
    const existing = services.pipeline.repo.runForRecording(id);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      void services.pipeline.resumeRunById(existing.id).catch(() => undefined);
      return reply.send({ ok: true, run: services.pipeline.repo.getRun(existing.id) });
    }
    const result = services.pipeline.retry(id, true);
    if (!result.ok) throw new AppError('RECORDING_NOT_AVAILABLE', '管线正在排队或运行中', { recordingId: id });
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