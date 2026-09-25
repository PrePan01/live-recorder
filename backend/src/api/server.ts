import Fastify, { type FastifyInstance } from 'fastify';
import { defaultMessageFor, AppError, httpStatusFor } from '../types/error.js';
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
import { registerDiagnosticExportRoutes } from './routes/diagnostic-export.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerNamingRoutes } from './routes/naming.js';
import { registerOpenListRoutes } from './routes/openlist.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerResetRoutes } from './routes/reset.js';
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
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const writes = new Set<string>();
  app.addHook('preHandler', async (req) => {
    if (services.resetting) throw new AppError('DIAGNOSTIC_CONFLICT', '正在重置，请稍后重试');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) writes.add(req.id);
  });
  app.addHook('onResponse', async (req) => { writes.delete(req.id); });
  const sse = new SSEBroadcaster();
  const preview = new PreviewManager(services);
  services.manager.preview = preview;
  // 最后一个预览客户端断开时，停止该房间的 preview-only 拉流（#163）。
  preview.onRoomEmpty = (roomId) => {
    void services.manager.stopPreviewStream(roomId).catch(() => undefined);
  };
  const extraOrigins = opts.extraOrigins ?? [];
  const port = opts.instance?.port ?? DEFAULT_PORT;
  const instance = opts.instance ?? null;

  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    // Tauri 2 WebView 的 Host 头（macOS http://tauri.localhost、Windows tauri://localhost）。
    'tauri.localhost',
    'tauri://localhost',
    '127.0.0.1:5173',
    'localhost:5173',
  ]);
  const baseOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://tauri.localhost', 'tauri://localhost'];
  const allowedOrigins = new Set([...baseOrigins, ...extraOrigins]);

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    const livePort = instance?.port ?? port;
    if (host && !allowedHosts.has(host) && host !== `127.0.0.1:${livePort}` && host !== `localhost:${livePort}`) {
      return reply.status(403).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: '仅允许本机访问', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    // CORS：Origin 命中白名单时放行并回 CORS 头（WebView/浏览器跨域请求即使服务端 200，缺 ACAO 也会被浏览器拦截）。
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin) && origin !== `http://127.0.0.1:${livePort}` && origin !== `http://localhost:${livePort}`) {
        return reply.status(403).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Origin 不在白名单', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
        });
      }
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      reply.header('Vary', 'Origin');
    }
    // OPTIONS 预检：直接 204，不进入路由（避免 404）。
    if (req.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      const obj = err.toObject();
      // 兜住空/纯空白 message：13 码默认文案在案，前端 describeError 永不空转（#20 后端面）。
      if (!obj.message || obj.message.trim().length === 0) {
        obj.message = defaultMessageFor(err.code) ?? '请求处理失败';
      }
      return reply.status(httpStatusFor(err.code)).send({ error: obj });
    }
    const validation = (err as { statusCode?: number; code?: string; message?: string });
    // 请求体超限（如超大备份导入）：413 友好提示，不落 500 内部错误。
    if (validation.statusCode === 413 || validation.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: { code: 'CONFIG_INVALID', message: '内容过大，超出处理上限，请检查导入文件', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    // 客户端请求非法（字段校验 FST_ERR_VALIDATION*、空 JSON body FST_ERR_CTP* 等）→ 400，
    // 归为 CONFIG_LOAD_FAILED，不落 500 内部错误（QA：空 body+JSON Content-Type 曾误报 500）。
    if (validation.statusCode === 400 && (validation.code?.startsWith('FST_ERR_VALIDATION') || validation.code?.startsWith('FST_ERR_CTP'))) {
      return reply.status(400).send({
        error: { code: 'CONFIG_INVALID', message: '请求字段非法', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false },
      });
    }
    // 同文案未读告警只刷新时间不新建：持续崩溃的接口不应把告警中心刷成流水（与 scheduler 同款去重）。
    const alert = services.alerts.createOrRefresh({ level: 'error', source: 'service', message: `内部错误: ${validation.message ?? 'unknown'}`, occurredAt: services.clock.iso() });
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
        setupCompleted: Boolean(stored?.recordingDirectory?.length),
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
  registerDiagnosticExportRoutes(app, services);
  registerNotificationRoutes(app, services);
  registerPipelineRoutes(app, services);
  registerNamingRoutes(app, services);
  registerOpenListRoutes(app, services);
  registerScheduleRoutes(app, services);
  registerExportRoutes(app, services);
  registerResetRoutes(app, services, () => writes.size);
  registerSse(app, services, sse);

  const ws = attachWebSocketUpgrade(services, preview, app.server, extraOrigins, () => instance?.port ?? port);
  // preClose 先于 Fastify 内部的 server.close() 执行：预览 WebSocket 升级后脱离 HTTP 连接跟踪，
  // 留给 onClose 会太晚——server.close() 会一直等这些连接（forceCloseConnections 只销毁普通连接），
  // 直播墙开着预览时退出/重启服务就被拖到 Rust 侧超时强杀（#直播墙退出卡住）。
  app.addHook('preClose', async () => {
    ws.dispose();
    preview.closeAll(1001);
  });
  app.addHook('onClose', async () => {
    services.scheduler.stop();
    // 关库之前先把正在录制的会话收尾：停拉流并等写流落盘关闭。
    // 否则退出时最后几秒数据还在缓冲里就没了，记录也会留在"录制中"。
    await services.manager.shutdown();
    sse.stop();
    services.db.close();
  });

  return { app, sse, preview, ws };
}
