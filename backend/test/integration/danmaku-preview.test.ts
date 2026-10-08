import { expect, it, vi } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { buildApp } from '../../src/api/server.js';
import { DanmakuManager } from '../../src/danmaku/manager.js';
import type { DanmakuAdapter } from '../../src/danmaku/types.js';
const headers = { host: '127.0.0.1:43120' };

it('serves incremental room preview independently of recording, validates requests and releases the lease', async () => {
  const services = buildServices({ dbPath: ':memory:' });
  let calls = 0, active = 0;
  const adapter: DanmakuAdapter = {
    platform: 'fake',
    async *collect(_room, _cookie, signal, ready) {
      calls++; active++; ready?.();
      try {
        yield { id: 'live', tMs: null, wallMs: Date.now(), text: '没有录制也能看弹幕' };
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      } finally { active--; }
    },
  };
  services.danmaku = new DanmakuManager(services, () => adapter);
  const { app } = buildApp(services);
  try {
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'room' });
    services.rooms.update(room.id, { danmakuEnabled: false });
    const url = `/api/v1/rooms/${room.id}/danmaku-preview/12345678-1234-1234`;
    const start = await app.inject({ method: 'POST', url, headers });
    expect(start.statusCode).toBe(200);
    let data: { messages: unknown[]; cursor: number; status: { state: string } };
    await vi.waitFor(async () => {
      data = (await app.inject({ method: 'GET', url, headers })).json();
      expect(data.messages).toHaveLength(1);
    });
    expect(data!.status.state).toBe('collecting');
    expect(calls).toBe(1);
    const next = await app.inject({ method: 'GET', url: `${url}?cursor=${data!.cursor}`, headers });
    expect(next.json().messages).toEqual([]);
    const again = await app.inject({ method: 'POST', url, headers });
    expect(again.statusCode).toBe(200); expect(calls).toBe(1);
    const bad = await app.inject({ method: 'GET', url: `${url}?cursor=-1`, headers });
    expect(bad.statusCode).toBe(422);
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/danmaku-preview/short`, headers });
    expect(invalid.statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(200);
    await vi.waitFor(() => expect(active).toBe(0));
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(200);
  } finally { await app.close(); }
});
