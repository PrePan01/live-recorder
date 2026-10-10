import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { buildApp } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import {
  fetchRoomCover,
  coverFileName,
  registerRoomCoverRoutes,
} from '../../src/api/routes/room-cover.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import type { Room } from '../../src/types/room.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
  'base64',
);
const room = {
  id: 'r1',
  platform: 'bilibili',
  displayName: '主播',
  lastLiveStatus: 'live',
  liveCoverUrl: 'https://i0.hdslb.com/cover.png',
} as Room;
const fetcher = vi.fn<typeof fetch>(
  async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
);
const servicesToClose: Services[] = [];
afterEach(() => {
  for (const s of servicesToClose.splice(0)) s.db.close();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
  servicesToClose.push(services);
  const created = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/1',
    displayName: '主播',
  });
  services.rooms.setLiveStatus(created.id, 'live');
  services.rooms.update(created.id, { liveCoverUrl: room.liveCoverUrl });
  return { services, id: created.id };
}

describe('cover retrieval', () => {
  it('returns original bytes and checks the image signature, with a platform Referer', async () => {
    expect(await fetchRoomCover(room, fetcher)).toEqual({
      bytes: png,
      type: 'image/png',
      extension: 'png',
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Referer: 'https://live.bilibili.com/',
    });
  });
  it.each([
    [
      'HTML',
      () =>
        new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ],
    [
      'fake image',
      () =>
        new Response('not an image', {
          headers: { 'content-type': 'image/png' },
        }),
    ],
    [
      'oversized',
      () =>
        new Response(png, {
          headers: {
            'content-type': 'image/png',
            'content-length': '99999999',
          },
        }),
    ],
    ['HTTP failure', () => new Response('', { status: 403 })],
    [
      'network failure',
      () => {
        throw new Error('network');
      },
    ],
  ])('rejects %s', async (_, response) => {
    await expect(
      fetchRoomCover(
        room,
        vi.fn(async () => response()),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
  });
  it('rejects a missing cover, unsafe address, and unsafe redirect', async () => {
    await expect(
      fetchRoomCover({ ...room, lastLiveStatus: 'offline' }, fetcher),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      fetchRoomCover(
        { ...room, liveCoverUrl: 'http://127.0.0.1/secret' },
        fetcher,
      ),
    ).rejects.toThrow('封面地址无效');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      fetchRoomCover(
        room,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/secret' },
          }),
      ),
    ).rejects.toThrow('封面地址无效');
  });
  it('sanitizes dialog names and keeps the original format', () => {
    expect(
      coverFileName(
        { ...room, displayName: 'a\"\'/$`b' },
        'webp',
        new Date('2026-10-07T12:00:00Z'),
      ),
    ).toBe('a_____b-直播封面-20261007T120000Z.webp');
  });
});

describe('cover routes', () => {
  it('previews and downloads original bytes with the appropriate headers', async () => {
    const { services, id } = setup();
    const app = Fastify();
    registerRoomCoverRoutes(app, services, { fetcher });
    const preview = await app.inject(`/api/v1/rooms/${id}/cover`);
    expect(preview.rawPayload).toEqual(png);
    expect(preview.headers['content-type']).toBe('image/png');
    const download = await app.inject(`/api/v1/rooms/${id}/cover?download=1`);
    expect(download.headers['content-disposition']).toContain(
      "filename*=UTF-8''",
    );
    expect(download.rawPayload).toEqual(png);
    await app.close();
  });
  it.each(['http://tauri.localhost', 'http://localhost:5173'])(
    'exposes the complete cover filename to an allowed cross-origin client (%s)',
    async (origin) => {
      const clock = new FakeClock(Date.parse('2026-10-07T12:34:56.000Z'));
      const services = buildServices({ dbPath: ':memory:', mode: 'fake', clock });
      const created = services.rooms.create({
        platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: '主播',
      });
      services.rooms.setLiveStatus(created.id, 'live');
      services.rooms.update(created.id, { liveCoverUrl: room.liveCoverUrl });
      vi.stubGlobal('fetch', fetcher);
      const { app } = buildApp(services, { extraOrigins: ['http://localhost:5173'] });
      try {
        const response = await app.inject({
          method: 'GET', url: `/api/v1/rooms/${created.id}/cover?download=1`,
          headers: { host: '127.0.0.1:43120', origin },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-expose-headers']).toBe('Content-Disposition');
        const encodedName = String(response.headers['content-disposition']).match(/filename\*=UTF-8''([^;]+)/)?.[1];
        expect(decodeURIComponent(encodedName!)).toBe('主播-直播封面-20261007T123456Z.png');
        expect(response.rawPayload).toEqual(png);
      } finally {
        await app.close();
      }
    },
  );
  it.each(['cancelled', 'unsupported', 'saved'] as const)(
    'handles save dialog %s',
    async (status) => {
      const { services, id } = setup();
      const app = Fastify();
      const write = vi.fn(async () => undefined);
      const pickSave = vi.fn(async () =>
        status === 'saved' ? { status, path: '/tmp/cover' } : { status },
      );
      registerRoomCoverRoutes(app, services, { fetcher, pickSave, write });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${id}/cover/save`,
      });
      expect(response.json()).toMatchObject({
        saved: status === 'saved',
        reason:
          status === 'unsupported'
            ? 'no-dialog'
            : status === 'cancelled'
              ? 'cancelled'
              : null,
      });
      if (status === 'saved')
        expect(write).toHaveBeenCalledWith('/tmp/cover.png', png);
      else expect(write).not.toHaveBeenCalled();
      await app.close();
    },
  );
  it('reports write failures and missing rooms', async () => {
    const { services, id } = setup();
    const app = Fastify();
    registerRoomCoverRoutes(app, services, {
      fetcher,
      pickSave: async () => ({ status: 'saved', path: '/tmp/cover.png' }),
      write: async () => {
        throw new Error('denied');
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${id}/cover/save`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toContain('无法将封面保存');
    expect((await app.inject('/api/v1/rooms/missing/cover')).statusCode).toBe(
      500,
    );
    await app.close();
  });
});

describe('cover persistence and lifecycle', () => {
  it('migrates old rooms to null and does not reapply the migration', () => {
    const { services, id } = setup();
    services.db.exec(
      'ALTER TABLE rooms DROP COLUMN live_cover_url; DELETE FROM schema_version WHERE version=45',
    );
    expect(runMigrations(services.db)).toBe(1);
    expect(services.rooms.get(id)?.liveCoverUrl).toBeNull();
    expect(runMigrations(services.db)).toBe(0);
  });
  it('updates via checks and SSE, retains same-session cover, clears offline/restricted and new-session missing cover', async () => {
    const { services, id } = setup();
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    const seen: Array<string | null | undefined> = [];
    services.events.on((event) => {
      if (event.type === 'room:updated') seen.push(event.data.liveCoverUrl);
    });
    adapter.setScript([
      { status: 'live', liveCoverUrl: 'https://i0.hdslb.com/new.png' },
      { status: 'live' },
      { status: 'error' },
      { status: 'offline' },
      { status: 'live' },
      { status: 'restricted' },
    ]);
    const expected = [
      'https://i0.hdslb.com/new.png',
      'https://i0.hdslb.com/new.png',
      'https://i0.hdslb.com/new.png',
      null,
      null,
      null,
    ];
    for (const cover of expected) {
      await services.scheduler.checkRoom(services.rooms.get(id)!, {
        nameOnly: true,
      });
      expect(services.rooms.get(id)?.liveCoverUrl).toBe(cover);
    }
    expect(seen).toContain('https://i0.hdslb.com/new.png');
    expect(seen).toContain(null);
  });
});
