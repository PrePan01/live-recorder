import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import type { RecordingState } from '../../types/index.js';

const STATES: RecordingState[] = ['pending', 'recording', 'reconnecting', 'completed', 'failed'];

export function registerRecordingRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/recordings', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Number(q.page ?? '1');
    const pageSize = Number(q.pageSize ?? '20');
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1) {
      return reply.status(400).send({
        error: { code: 'CONFIG_LOAD_FAILED', message: '分页参数非法', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    if (q.state && !STATES.includes(q.state as RecordingState)) {
      return reply.status(400).send({
        error: { code: 'CONFIG_LOAD_FAILED', message: 'state 过滤值非法', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    const result = services.recordings.list({
      page,
      pageSize,
      roomId: q.roomId,
      state: q.state as RecordingState | undefined,
      sessionId: q.sessionId,
      groupBy: q.groupBy === 'session' ? 'session' : undefined,
    });
    return reply.send(result);
  });

  app.post('/api/v1/recordings/:id/open', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec || !rec.filePath) {
      throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在或文件缺失', { recordingId: id, details: { resource: 'recording' } });
    }
    return reply.send({ ok: true });
  });
}
