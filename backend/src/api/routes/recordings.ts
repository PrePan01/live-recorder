import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { rename, unlink } from 'node:fs/promises';
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
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
    });
    return reply.send(result);
  });

  app.post('/api/v1/recordings/:id/open', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec || !rec.filePath) {
      throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在或文件缺失', { recordingId: id, details: { resource: 'recording' } });
    }
    const dir = dirname(rec.filePath);
    if (process.env.VITEST !== 'true') {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      const child = spawn(command, [dir], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return reply.send({ ok: true });
  });

  // 历史页回放：仅 completed 且文件存在的录制可读取，按 FLV 内容输出（.flv/.mkv 均实为 FLV 字节）。
  app.get('/api/v1/recordings/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec || !rec.filePath || rec.state !== 'completed') {
      throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在或文件缺失', { recordingId: id, details: { resource: 'recording' } });
    }
    let size: number;
    try {
      size = (await stat(rec.filePath)).size;
    } catch {
      throw new AppError('RESOURCE_NOT_FOUND', '录制文件缺失', { recordingId: id, details: { resource: 'recording' } });
    }
    if (size <= 0) {
      throw new AppError('RECORDING_FILE_CORRUPTED', '录制文件为空或不可读', { recordingId: id, retryable: false });
    }
    reply.header('Content-Type', 'video/x-flv');
    reply.header('Content-Length', String(size));
    return reply.send(createReadStream(rec.filePath));
  });

  app.patch('/api/v1/recordings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { streamTitle?: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    }
    if (typeof body.streamTitle !== 'string' || body.streamTitle.trim().length === 0) {
      throw new AppError('CONFIG_LOAD_FAILED', 'streamTitle 必须为非空字符串', { recordingId: id });
    }
    const title = body.streamTitle.trim();
    // 重命名同步改名落盘文件（保留目录与扩展名），文件缺失时仅改记录并容错。
    if (rec.filePath) {
      const dir = dirname(rec.filePath);
      const ext = extnameOf(rec.filePath);
      const nextName = sanitizeFileBase(title) + ext;
      const nextPath = join(dir, nextName);
      try {
        await rename(rec.filePath, nextPath);
        services.recordings.update(id, { streamTitle: title, filePath: nextPath });
      } catch {
        // 文件缺失/重命名失败：仅更新记录标题，不阻断。
        services.recordings.update(id, { streamTitle: title });
      }
    } else {
      services.recordings.update(id, { streamTitle: title });
    }
    const updated = services.recordings.get(id)!;
    services.events.emit({ type: 'recording:updated', data: updated });
    return reply.send({ recording: updated });
  });

  app.delete('/api/v1/recordings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    }
    // 连带删除文件；文件缺失容错（记录仍删除）。
    if (rec.filePath) {
      await unlink(rec.filePath).catch(() => undefined);
    }
    services.recordings.remove(id);
    return reply.status(204).send();
  });
}

function extnameOf(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

function sanitizeFileBase(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'recording';
}
