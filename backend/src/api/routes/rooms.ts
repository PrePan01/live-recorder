import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Platform } from '../../types/index.js';
import type { Services } from '../../core/services.js';

const PLATFORMS: Platform[] = ['bilibili', 'douyin'];

export function registerRoomRoutes(app: FastifyInstance, services: Services): void {
  const enrich = (room: import('../../types/index.js').Room) => services.manager.enrichRoom(room);

  app.get('/api/v1/rooms', async (_req, reply) => {
    return reply.send({ rooms: services.rooms.list().map(enrich) });
  });

  app.post('/api/v1/rooms', async (req, reply) => {
    const body = (req.body ?? {}) as { platform?: string; url?: string; displayName?: string; enabled?: boolean };
    if (!PLATFORMS.includes(body.platform as Platform) || typeof body.url !== 'string' || body.url.length === 0) {
      throw new AppError('ROOM_LINK_INVALID', '链接无效或平台不支持');
    }
    const adapter = services.adapterFor(body.platform as Platform);
    if (!adapter.validateUrl(body.url)) {
      throw new AppError('ROOM_LINK_INVALID', '链接无效或平台不支持');
    }
    const room = services.rooms.create({
      platform: body.platform as Platform,
      url: adapter.normalizeUrl(body.url),
      displayName: typeof body.displayName === 'string' ? body.displayName : '',
      enabled: body.enabled ?? true,
    });
    // #162：添加后立即触发一次检测，让显示名尽快自动解析（否则要等调度器最长 120s，期间名字为空）。
    void services.scheduler.triggerImmediateCheck(room.id, { nameOnly: true }).catch(() => undefined);
    services.events.emit({ type: 'room:updated', data: enrich(room) });
    return reply.status(201).send({ room: enrich(room) });
  });

  app.post('/api/v1/rooms/batch', async (req, reply) => {
    const body = (req.body ?? {}) as { urls?: unknown };
    if (!Array.isArray(body.urls) || body.urls.length === 0) {
      throw new AppError('ROOM_LINK_INVALID', 'urls 必须为非空数组');
    }
    if (body.urls.length > 100) {
      throw new AppError('ROOM_LINK_INVALID', '单次批量最多 100 条');
    }
    // 批内+现库去重，按规范化链接识别。
    const existing = new Set(services.rooms.list().map((r) => `${r.platform}|${r.url}`));
    const seen = new Set<string>();
    const succeeded: Array<import('../../types/index.js').Room> = [];
    const failed: Array<{ url: string; reason: string }> = [];
    for (const raw of body.urls) {
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (!url) {
        failed.push({ url: typeof raw === 'string' ? raw : String(raw), reason: 'URL 为空' });
        continue;
      }
      const platform = PLATFORMS.find((p) => services.adapterFor(p).validateUrl(url));
      if (!platform) {
        failed.push({ url, reason: '无效链接或平台不支持' });
        continue;
      }
      const adapter = services.adapterFor(platform);
      const normalized = adapter.normalizeUrl(url);
      const key = `${platform}|${normalized}`;
      if (existing.has(key) || seen.has(key)) {
        failed.push({ url, reason: '该直播间已存在' });
        continue;
      }
      const room = services.rooms.create({ platform, url: normalized, displayName: '' });
      existing.add(key);
      seen.add(key);
      succeeded.push(room);
      // #162：批量添加同样即时触发检测，让显示名尽快自动解析。
      void services.scheduler.triggerImmediateCheck(room.id, { nameOnly: true }).catch(() => undefined);
    }
    for (const room of succeeded) services.events.emit({ type: 'room:updated', data: enrich(room) });
    return reply.send({ succeeded: succeeded.map(enrich), failed });
  });

  app.patch('/api/v1/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { url?: string; displayName?: string; enabled?: boolean; autoRecord?: boolean | null; uploadEnabled?: boolean | null };
    const patch: { url?: string; displayName?: string; enabled?: boolean; autoRecord?: boolean | null; uploadEnabled?: boolean | null } = {};
    if (body.url !== undefined) {
      const existing = services.rooms.get(id);
      const adapter = services.adapterFor(existing?.platform ?? 'bilibili');
      if (typeof body.url !== 'string' || !adapter.validateUrl(body.url)) {
        throw new AppError('ROOM_LINK_INVALID', '链接无效或平台不支持', { roomId: id });
      }
      patch.url = adapter.normalizeUrl(body.url);
    }
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.autoRecord !== undefined) {
      // null=恢复继承全局；布尔=单独覆盖。
      if (body.autoRecord !== null && typeof body.autoRecord !== 'boolean') {
        throw new AppError('ROOM_LINK_INVALID', 'autoRecord 必须为布尔值或 null', { roomId: id });
      }
      patch.autoRecord = body.autoRecord;
    }
    if (body.uploadEnabled !== undefined) {
      // V5：null=继承全局 openlist.enabled；布尔=单独覆盖。
      if (body.uploadEnabled !== null && typeof body.uploadEnabled !== 'boolean') {
        throw new AppError('ROOM_LINK_INVALID', 'uploadEnabled 必须为布尔值或 null', { roomId: id });
      }
      patch.uploadEnabled = body.uploadEnabled;
    }
    const room = services.rooms.update(id, patch);
    services.events.emit({ type: 'room:updated', data: enrich(room) });
    return reply.send({ room: enrich(room) });
  });

  app.patch('/api/v1/rooms/:id/enable', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      throw new AppError('ROOM_LINK_INVALID', 'enabled 必须为布尔值', { roomId: id });
    }
    const room = services.rooms.update(id, { enabled: body.enabled });
    services.events.emit({ type: 'room:updated', data: enrich(room) });
    return reply.send({ room: enrich(room) });
  });

  app.patch('/api/v1/rooms/:id/favorite', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { favorited?: boolean };
    if (typeof body.favorited !== 'boolean') {
      throw new AppError('ROOM_LINK_INVALID', 'favorited 必须为布尔值', { roomId: id });
    }
    const room = services.rooms.setFavorite(id, body.favorited);
    services.events.emit({ type: 'room:updated', data: enrich(room) });
    return reply.send({ room: enrich(room) });
  });

  app.delete('/api/v1/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = services.rooms.get(id);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    services.rooms.remove(id);
    services.events.emit({ type: 'room:updated', data: enrich({ ...existing, enabled: false, monitorState: 'disabled' }) });
    return reply.status(204).send();
  });

  app.post('/api/v1/rooms/:id/check', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    await services.scheduler.triggerImmediateCheck(id);
    return reply.send({ ok: true });
  });

  app.post('/api/v1/rooms/:id/stop-recording', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    if (!services.manager.isRoomActive(id)) {
      throw new AppError('PREVIEW_NOT_RECORDING', '当前未在录制', { roomId: id });
    }
    await services.manager.stopRecording(id);
    return reply.send({ ok: true });
  });

  // 房间健康度概览（#70）：近 N 天录制次数/大小聚合 + 成功率窗口。
  app.get('/api/v1/rooms/:id/stats', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    const q = req.query as Record<string, string | undefined>;
    const days = Math.min(30, Math.max(1, Number(q.days ?? '7') || 7));
    const fromIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const recs = services.recordings.list({ roomId: id, pageSize: 100, dateFrom: fromIso }).items;
    const totalBytes = recs.reduce((acc, r) => acc + (r.fileSizeBytes || 0), 0);
    const completed = recs.filter((r) => r.state === 'completed').length;
    const failed = recs.filter((r) => r.state === 'failed').length;
    const rate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : 100;
    const byDay = new Map<string, { count: number; bytes: number }>();
    for (const r of recs) {
      const day = r.startedAt.slice(0, 10);
      const cur = byDay.get(day) ?? { count: 0, bytes: 0 };
      cur.count += 1;
      cur.bytes += r.fileSizeBytes || 0;
      byDay.set(day, cur);
    }
    return reply.send({
      roomId: id,
      days,
      totalRecordings: recs.length,
      totalBytes,
      successRate: rate,
      completed,
      failed,
      lastCheckedAt: room.lastCheckedAt,
      lastError: room.lastError,
      byDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, count: v.count, bytes: v.bytes })),
    });
  });

  // 手动「录制」按钮（#79）：开播状态下显式强制开始录制，绕过 autoRecord 检查。
  app.post('/api/v1/rooms/:id/start-recording', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    if (services.manager.isRoomActive(id)) {
      throw new AppError('RECORDING_NOT_AVAILABLE', '该房间正在录制中', { roomId: id, retryable: false });
    }
    // 确认开播：lastLiveStatus 为准（未检测过则触发一次实时检测）。
    let live = room.lastLiveStatus === 'live';
    if (room.lastLiveStatus === null) {
      const cookie = await services.platformCookie(room.platform);
      const status = await services.adapterFor(room.platform).checkLiveStatus(room.url, cookie);
      if (status.status === 'live' || status.status === 'offline' || status.status === 'restricted') {
        services.rooms.setLiveStatus(room.id, status.status);
      }
      live = status.status === 'live';
    }
    if (!live) {
      throw new AppError('RECORDING_NOT_AVAILABLE', '直播间未开播，无法手动录制', { roomId: id, retryable: false });
    }
    const cookie = await services.platformCookie(room.platform);
    const status = await services.adapterFor(room.platform).checkLiveStatus(room.url, cookie);
    if (status.status !== 'live') {
      throw new AppError('RECORDING_NOT_AVAILABLE', '直播间未开播，无法手动录制', { roomId: id, retryable: false });
    }
    await services.manager.maybeStartRecording({ ...room, monitorState: 'idle' }, status, { manual: true });
    return reply.send({ ok: true });
  });
}
