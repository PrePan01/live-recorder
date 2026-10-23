import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import type { AppEvent } from '../../src/core/events.js';
import type { Platform, Room } from '../../src/types/index.js';

const headers = { host: '127.0.0.1:43120' };
const opened: ReturnType<typeof setup>[] = [];
function setup() {
  const services = buildServices({ dbPath: ':memory:' });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: '/tmp/lr-effective-policy' });
  const { app } = buildApp(services);
  const events: AppEvent[] = [];
  services.events.on(event => events.push(event));
  const create = (id: number, patch: Partial<Room> = {}) => services.rooms.create({
    platform: 'bilibili', url: `https://live.bilibili.com/${id}`, displayName: `Room ${id}`, ...patch,
  });
  const save = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload });
  const updated = () => events.flatMap(event => event.type === 'room:updated' ? [event.data] : []);
  const result = { services, app, events, create, save, updated };
  opened.push(result);
  return result;
}
afterEach(async () => {
  for (const { app, services } of opened.splice(0)) {
    await app.close();
    services.scheduler.stop();
    services.quality.stop();
    await services.manager.shutdown();
    services.db.close();
  }
});

describe('effective room policy synchronization', () => {
  it('pushes current effective values for inherited rooms and preserves explicit overrides', async () => {
    const { app, services, create, save, updated } = setup();
    const inherited = create(100);
    const explicit = create(101, { checkIntervalSec: 60, quality: 'original', autoRecord: false, danmakuEnabled: false });
    const initial = (await app.inject({ method: 'GET', url: '/api/v1/rooms', headers })).json().rooms;
    expect(initial.find((room: Room) => room.id === inherited.id).effective.autoRecord).toEqual({ value: false, source: 'global' });
    const response = await save({ autoRecord: true, quality: '720p', danmaku: { enabled: true }, checkIntervalSec: { bilibili: 45 } });
    expect(response.statusCode).toBe(200);
    expect(updated()).toHaveLength(1);
    expect(updated()[0]).toMatchObject({ id: inherited.id, effective: {
      checkIntervalSec: { value: 45, source: 'global' },
      quality: { value: '720p', source: 'global' },
      autoRecord: { value: true, source: 'global' },
      danmakuEnabled: { value: true, source: 'global' },
    } });
    expect(services.rooms.get(inherited.id)).toMatchObject({ checkIntervalSec: null, quality: null, autoRecord: null, danmakuEnabled: null });
    expect(services.manager.enrichRoom(services.rooms.get(explicit.id)!)).toMatchObject({ effective: {
      checkIntervalSec: { value: 60, source: 'room' }, quality: { value: 'original', source: 'room' },
      autoRecord: { value: false, source: 'room' }, danmakuEnabled: { value: false, source: 'room' },
    } });
  });

  it('does not scan or push rooms for unrelated or unchanged settings and rejects invalid saves', async () => {
    const { services, create, save, updated } = setup();
    create(100);
    const list = vi.spyOn(services.rooms, 'list');
    expect((await save({ theme: 'dark' })).statusCode).toBe(200);
    expect((await save({ quality: 'original' })).statusCode).toBe(200);
    // A default shadowed by every platform override changes no effective policy.
    expect((await save({ checkIntervalSec: { default: 90 } })).statusCode).toBe(200);
    expect((await save({ checkIntervalSec: { bilibili: 0 } })).statusCode).toBe(422);
    expect(updated()).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('refreshes only the affected platform and handles consecutive setting changes', async () => {
    const { create, save, updated, events } = setup();
    const platforms: Platform[] = ['bilibili', 'douyin', 'xiaohongshu', 'youtube'];
    const rooms = platforms.map((platform, i) => create(100 + i, { platform }));
    expect((await save({ checkIntervalSec: { bilibili: 45 } })).statusCode).toBe(200);
    expect(updated().map(room => room.id)).toEqual([rooms[0]!.id]);
    events.length = 0;
    expect((await save({ checkIntervalSec: { douyin: 90 } })).statusCode).toBe(200);
    expect(updated().map(room => room.id)).toEqual([rooms[1]!.id]);
    events.length = 0;
    expect((await save({ checkIntervalSec: { bilibili: 60 } })).statusCode).toBe(200);
    expect(updated()).toHaveLength(1);
    expect(updated()[0]!.effective!.checkIntervalSec.value).toBe(60);
  });

  it('reads a single configuration snapshot for room lists and reorder responses', async () => {
    const { services, app, create } = setup();
    const rooms = Array.from({ length: 100 }, (_, i) => create(100 + i));
    const load = vi.spyOn(services.settings, 'load');
    const response = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().rooms).toHaveLength(100);
    expect(load).toHaveBeenCalledTimes(1);
    load.mockClear();
    const ordered = await app.inject({ method: 'PUT', url: '/api/v1/rooms/order', headers,
      payload: { roomIds: rooms.map(room => room.id).reverse() } });
    expect(ordered.statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ordered.json().rooms.map((room: Room) => room.id)).toEqual(rooms.map(room => room.id).reverse());
    load.mockClear().mockReturnValue(null);
    const emptySettings = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers });
    expect(emptySettings.statusCode).toBe(200);
    expect(emptySettings.json().rooms[0].effective.autoRecord).toEqual({ value: false, source: 'global' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
