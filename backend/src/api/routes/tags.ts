import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

const NAME_MAX = 30;
const MAX_TAGS_PER_ROOM = 20;

function tagError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = String((err as { message?: string }).message ?? '');
  if (message === 'TAG_NAME_DUPLICATE') return new AppError('TAG_INVALID', '标签名已存在');
  if (message === 'TAG_NOT_FOUND') return new AppError('RESOURCE_NOT_FOUND', '标签不存在', { details: { resource: 'tag' } });
  return new AppError('TAG_INVALID', '标签操作失败');
}

export function registerTagRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/tags', async (_req, reply) => {
    return reply.send({ tags: services.tags.list() });
  });

  app.post('/api/v1/tags', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; color?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) {
      throw new AppError('TAG_INVALID', `标签名长度需在 1-${NAME_MAX} 之间`);
    }
    const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#1677ff';
    try {
      const tag = services.tags.create({ name, color });
      return reply.status(201).send({ tag });
    } catch (err) {
      throw tagError(err);
    }
  });

  app.patch('/api/v1/tags/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; color?: unknown };
    const patch: { name?: string; color?: string } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > NAME_MAX) throw new AppError('TAG_INVALID', `标签名长度需在 1-${NAME_MAX} 之间`);
      patch.name = name;
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
        throw new AppError('TAG_INVALID', '颜色必须为 #RRGGBB');
      }
      patch.color = body.color;
    }
    try {
      const tag = services.tags.update(id, patch);
      return reply.send({ tag });
    } catch (err) {
      throw tagError(err);
    }
  });

  app.delete('/api/v1/tags/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tag = services.tags.get(id);
    if (!tag) throw new AppError('RESOURCE_NOT_FOUND', '标签不存在', { details: { resource: 'tag' } });
    services.tags.remove(id);
    return reply.status(204).send();
  });

  // 覆盖式设置房间标签：body { tagIds: string[] }（≤20），标签不存在→404。
  app.put('/api/v1/rooms/:id/tags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { tagIds?: unknown };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    if (!Array.isArray(body.tagIds) || body.tagIds.some((t) => typeof t !== 'string')) {
      throw new AppError('TAG_INVALID', 'tagIds 必须为字符串数组');
    }
    if (body.tagIds.length > MAX_TAGS_PER_ROOM) {
      throw new AppError('TAG_INVALID', `单房间标签最多 ${MAX_TAGS_PER_ROOM} 个`);
    }
    try {
      const tags = services.tags.setRoomTags(id, body.tagIds as string[]);
      const updated = services.rooms.get(id)!;
      services.events.emit({ type: 'room:updated', data: services.manager.enrichRoom(updated) });
      return reply.send({ room: services.manager.enrichRoom({ ...updated, tags }) });
    } catch (err) {
      throw tagError(err);
    }
  });
}