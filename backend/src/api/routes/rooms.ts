import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Platform } from '../../types/index.js';
import type { Services } from '../../core/services.js';

const PLATFORMS: Platform[] = ['bilibili', 'douyin'];

export function registerRoomRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/rooms', async (_req, reply) => {
    return reply.send({ rooms: services.rooms.list() });
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
    services.events.emit({ type: 'room:updated', data: room });
    return reply.status(201).send({ room });
  });

  app.patch('/api/v1/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { url?: string; displayName?: string; enabled?: boolean };
    const patch: { url?: string; displayName?: string; enabled?: boolean } = {};
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
    const room = services.rooms.update(id, patch);
    services.events.emit({ type: 'room:updated', data: room });
    return reply.send({ room });
  });

  app.patch('/api/v1/rooms/:id/enable', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      throw new AppError('ROOM_LINK_INVALID', 'enabled 必须为布尔值', { roomId: id });
    }
    const room = services.rooms.update(id, { enabled: body.enabled });
    services.events.emit({ type: 'room:updated', data: room });
    return reply.send({ room });
  });

  app.delete('/api/v1/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = services.rooms.get(id);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    services.rooms.remove(id);
    services.events.emit({ type: 'room:updated', data: { ...existing, enabled: false, monitorState: 'disabled' } });
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
}
