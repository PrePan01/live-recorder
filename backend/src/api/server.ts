import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, httpStatusFor } from '../types/error.js';
import type { Services } from '../core/services.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerServiceRoutes } from './routes/service.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerDiagnosticRoutes } from './routes/diagnostics.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerNamingRoutes } from './routes/naming.js';
import { registerOpenListRoutes } from './routes/openlist.js';
import { SSEBroadcaster, registerSse } from './sse.js';
import { PreviewManager, attachWebSocketUpgrade } from './websocket.js';
import { DEFAULT_PORT } from '../sidecar/ports.js';
import { APP_VERSION } from '../sidecar/types.js';
import type { AppInstance } from '../sidecar/types.js';

export interface BuildAppOptions {
  extraOrigins?: string[];
  /** 桌面 sidecar 实例上下文：注入健康响应实例/端口字段，并据此放行本机 Host/Origin。 */
  instance?: AppInstance;
}

export interface BuiltApp {
  app: FastifyInstance;
  sse: SSEBroadcaster;
  preview: PreviewManager;
  ws: { dispose: () => void };
}

export function buildApp(services: Services, opts: BuildAppOptions = {}): BuiltApp {
  const app = Fastify({ logger: false });
  const sse = new SSEBroadcaster();
  const preview = new PreviewManager(services);
  services.manager.preview = preview;
  const extraOrigins = opts.extraOrigins ?? [];
  const port = opts.instance?.port ?? DEFAULT_PORT;
  const instance = opts.instance ?? null;

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const baseOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (host && !allowedHosts.has(host)) {
      return reply.status(403).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: '仅允许本机访问', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    const allowedOrigins = new Set([...baseOrigins, ...extraOrigins]);
    if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) {
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
    const alert = services.alerts.create({ level: 'error', source: 'service', message: `内部错误: ${validation.message ?? 'unknown'}`, occurredAt: services.clock.iso() });
    services.events.emit({ type: 'alert:created', data: alert });
    return reply.status(500).send({
      error: { code: 'SERVICE_UNAVAILABLE', message: '服务内部错误', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: true },
    });
  });

  app.get('/api/v1/health', async (_req, reply) => {
    const stored = services.settings.load();
    return reply.send({
      serviceStatus: {
        state: 'running',
        version: APP_VERSION,
        uptimeSeconds: Math.round((services.clock.now() - services.startedAt) / 1000),
        setupCompleted: Boolean(stored && stored.recordingDirectory.length > 0),
        ...(instance
          ? {
              ready: true,
              instanceId: instance.instanceId,
              apiVersion: instance.apiVersion,
              port: instance.port,
              baseUrl: instance.baseUrl,
              startedAt: instance.startedAt,
            }
          : {}),
      },
    });
  });

  registerRoomRoutes(app, services);
  registerRecordingRoutes(app, services);
  registerSettingsRoutes(app, services);
  registerAlertRoutes(app, services);
  registerServiceRoutes(app, services);
  registerConfigRoutes(app, services);
  registerTagRoutes(app, services);
  registerSearchRoutes(app, services);
  registerStatsRoutes(app, services);
  registerDiagnosticRoutes(app, services);
  registerNotificationRoutes(app, services);
  registerPipelineRoutes(app, services);
  registerNamingRoutes(app, services);
  registerOpenListRoutes(app, services);
  registerSse(app, services, sse);

  const ws = attachWebSocketUpgrade(services, preview, app.server, extraOrigins, port);
  app.addHook('onClose', async () => {
    services.scheduler.stop();
    ws.dispose();
    sse.stop();
    for (const roomId of preview.trackedRooms()) preview.closeRoomWithError(roomId, 1001);
    services.db.close();
  });

  return { app, sse, preview, ws };
}
