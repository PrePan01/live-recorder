import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import type { OpenListConfig } from '../../types/index.js';
import { OPENLIST_TOKEN_KEY } from '../../security/keys.js';

export function registerOpenListRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings/openlist', async (_req, reply) => {
    return reply.send({ openlist: await openListView(services) });
  });

  app.put('/api/v1/settings/openlist', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<OpenListConfig> & { token?: unknown };
    const current = await openListView(services);
    const { token, ...rest } = body;
    if (typeof rest.enabled !== 'undefined' && typeof rest.enabled !== 'boolean') {
      throw new AppError('CONFIG_INVALID', 'enabled 必须为布尔值');
    }
    if (typeof rest.serverUrl !== 'undefined' && typeof rest.serverUrl !== 'string') {
      throw new AppError('CONFIG_INVALID', 'serverUrl 必须为字符串');
    }
    if (typeof rest.username !== 'undefined' && typeof rest.username !== 'string') {
      throw new AppError('CONFIG_INVALID', 'username 必须为字符串');
    }
    const merged: OpenListConfig = { ...current, ...rest, hasToken: current.hasToken };
    const settings = services.settings.load() ?? ({ recordingDirectory: '' } as Record<string, unknown>);
    services.settings.save({ ...settings, openlist: { enabled: merged.enabled, serverUrl: merged.serverUrl, directoryTemplate: merged.directoryTemplate, username: merged.username } } as never);
    // 令牌写 SecretStore：空串=清除，非空=设置（不落盘、不回显）。
    if (typeof token === 'string') {
      if (token.length > 0) await services.secretStore.set(OPENLIST_TOKEN_KEY, token);
      else await services.secretStore.delete(OPENLIST_TOKEN_KEY);
    }
    const view = await (await import('./settings-view.js')).settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ openlist: await openListView(services) });
  });

  // 连接测试：WebDAV 可达性（不泄露令牌）。
  app.post('/api/v1/settings/openlist/test', async (_req, reply) => {
    const config = await openListView(services);
    if (!config.serverUrl) throw new AppError('CONFIG_LOAD_FAILED', 'OpenList 地址未配置');
    if (!config.hasToken) throw new AppError('CONFIG_LOAD_FAILED', 'OpenList 令牌未配置');
    try {
      const token = await services.secretStore.get(OPENLIST_TOKEN_KEY);
      const res = await fetch(config.serverUrl, {
        method: 'OPTIONS',
        headers: { Authorization: `Basic ${Buffer.from(`${config.username}:${token}`).toString('base64')}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return reply.send({ ok: true });
    } catch {
      throw new AppError('CONFIG_LOAD_FAILED', 'OpenList 连接失败，请检查地址与令牌', { retryable: true });
    }
  });

  // 上传任务列表。
  app.get('/api/v1/uploads', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const jobs = services.uploader.uploadRepo.list({ limit: Number(qs.limit ?? '100') });
    return reply.send({ uploads: jobs });
  });

  // 重试失败/取消的上传。
  app.post('/api/v1/uploads/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await services.uploader.retry(id);
    if (!job) throw new AppError('RESOURCE_NOT_FOUND', '上传任务不存在', { details: { resource: 'upload' } });
    return reply.send({ upload: job });
  });

  // 取消排队/运行中的上传（不删本地原件）。
  app.post('/api/v1/uploads/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = services.uploader.cancel(id);
    if (!job) throw new AppError('RESOURCE_NOT_FOUND', '上传任务不存在', { details: { resource: 'upload' } });
    return reply.send({ upload: job });
  });

  // 手动触发上传某录制（幂等键=recordingId）。
  app.post('/api/v1/recordings/:id/upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) throw new AppError('RESOURCE_NOT_FOUND', '录制记录不存在', { recordingId: id, details: { resource: 'recording' } });
    if (!rec.filePath) throw new AppError('CONFIG_LOAD_FAILED', '录制无文件，无法上传', { recordingId: id });
    const job = await services.uploader.enqueue(id);
    if (!job) throw new AppError('CONFIG_LOAD_FAILED', 'OpenList 未启用或令牌未配置', { recordingId: id });
    return reply.send({ upload: job });
  });
}

/** OpenList 配置视图：令牌仅回显 hasToken，不回显值。 */
export async function openListView(services: Services): Promise<OpenListConfig> {
  const settings = services.settings.load();
  const stored = settings?.openlist as Partial<OpenListConfig> | undefined;
  const hasToken = await services.secretStore.has(OPENLIST_TOKEN_KEY);
  return {
    enabled: stored?.enabled ?? false,
    serverUrl: stored?.serverUrl ?? '',
    directoryTemplate: stored?.directoryTemplate ?? '{room}/{date}',
    username: stored?.username ?? '',
    hasToken,
  };
}