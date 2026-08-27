import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, httpStatusFor } from '../types/error.js';
import type { Services } from '../core/services.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerServiceRoutes } from './routes/service.js';

const ALLOWED_HOSTS = new Set(['127.0.0.1:43120', 'localhost:43120']);

function originAllowed(origin: string | undefined, extra: string[]): boolean {
  if (origin === undefined) return true;
  const allowed = new Set(['http://127.0.0.1:43120', 'http://localhost:43120', ...extra]);
  return allowed.has(origin);
}

export function buildApp(services: Services, opts: { extraOrigins?: string[] } = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (host && !ALLOWED_HOSTS.has(host)) {
      return reply.status(403).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: '仅允许本机访问', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    if (!originAllowed(req.headers.origin, opts.extraOrigins ?? [])) {
      return reply.status(403).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Origin 不在白名单', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(httpStatusFor(err.code)).send({ error: err.toObject() });
    }
    const validation = (err as { statusCode?: number; code?: string; message?: string });
    if (validation.statusCode === 400 && validation.code?.startsWith('FST_ERR_VALIDATION')) {
      return reply.status(400).send({
        error: { code: 'CONFIG_LOAD_FAILED', message: '请求字段非法', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    services.alerts.create({ level: 'error', source: 'service', message: `内部错误: ${validation.message ?? 'unknown'}`, occurredAt: services.clock.iso() });
    return reply.status(500).send({
      error: { code: 'SERVICE_UNAVAILABLE', message: '服务内部错误', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: true },
    });
  });

  app.get('/api/v1/health', async (_req, reply) => {
    const stored = services.settings.load();
    return reply.send({
      serviceStatus: {
        state: 'running',
        version: '0.1.0',
        uptimeSeconds: Math.round((services.clock.now() - services.startedAt) / 1000),
        setupCompleted: Boolean(stored && stored.recordingDirectory.length > 0),
      },
    });
  });

  registerRoomRoutes(app, services);
  registerRecordingRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerAlertRoutes(app, services);
  registerServiceRoutes(app, services);

  return app;
}
