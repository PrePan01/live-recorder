import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

async function listen(): Promise<{ url: string; close: () => Promise<void>; services: Services; preview: { broadcastFrame: (r: string, b: Buffer) => void; closeRoom: (r: string, c: number, reason?: 'ended' | 'stream_lost') => void } }> {
  const services = newServices();
  const built = buildApp(services, { extraOrigins: ['http://localhost:5173'] });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const address = built.app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    services,
    preview: built.preview,
    close: async () => {
      await built.app.close();
    },
  };
}

function openEventStream(url: string): { frames: string[]; req: http.ClientRequest; done: Promise<void> } {
  const frames: string[] = [];
  const req = http.get(`${url}/api/v1/events`, { headers: { Host: '127.0.0.1:43120' } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk: string) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        frames.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    });
  });
  const done = new Promise<void>((resolve) => req.on('close', resolve));
  return { frames, req, done };
}

describe('SSE events', () => {
  it('streams room:updated frames to subscribers', async () => {
    const server = await listen();
    const stream = openEventStream(server.url);
    await new Promise((r) => setTimeout(r, 100));

    const injectCreate = await server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/555', displayName: 'sse' });
    server.services.events.emit({ type: 'room:updated', data: injectCreate });
    await new Promise((r) => setTimeout(r, 100));
    expect(stream.frames.some((f) => f.includes('event: room:updated') && f.includes('"id":"room_'))).toBe(true);

    stream.req.destroy();
    await stream.done;
    await server.close();
  });
});

describe('WebSocket preview', () => {
  function connect(url: string, roomId: string): { ws: WebSocket; closed: Promise<number>; opened: Promise<void> } {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(url).port}/ws/preview/${roomId}`, { headers: { Host: '127.0.0.1:43120' } });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    return { ws, closed, opened };
  }

  it('accepts connections proxied from vite dev server host (localhost:5173)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'proxy' });
    server.services.rooms.setState(room.id, 'recording');

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(server.url).port}/ws/preview/${room.id}`, {
      headers: { Host: 'localhost:5173', Origin: 'http://localhost:5173' },
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await opened;
    ws.close();
    await closed;
    await server.close();
  });

  it('closes with 4002 when room is not recording', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'ws' });
    const { closed } = connect(server.url, room.id);
    expect(await closed).toBe(4002);
    await server.close();
  });

  it('accepts when recording, broadcasts frames, enforces limit, closes with stream_end', async () => {
    const server = await listen();
    const rooms = [
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'a' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'b' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: 'c' }),
    ];
    for (const r of rooms) server.services.rooms.setState(r.id, 'recording');

    const c1 = connect(server.url, rooms[0]!.id);
    await c1.opened;
    const c2 = connect(server.url, rooms[1]!.id);
    await c2.opened;
    const c3 = connect(server.url, rooms[2]!.id);
    expect(await c3.closed).toBe(4003);

    const frame = await new Promise<Buffer>((resolve) => {
      c1.ws.once('message', (data: Buffer) => resolve(Buffer.from(data)));
      server.preview.broadcastFrame(rooms[0]!.id, Buffer.from([1, 2, 3]));
    });
    expect([...frame]).toEqual([1, 2, 3]);

    const messages: Buffer[] = [];
    c1.ws.on('message', (m: Buffer) => messages.push(Buffer.from(m)));
    server.preview.closeRoom(rooms[0]!.id, 1000, 'ended');
    expect(await c1.closed).toBe(1000);
    expect(messages.some((m) => m.toString().includes('"stream_end"') && m.toString().includes('"ended"'))).toBe(true);

    c2.ws.close();
    await c2.closed;
    await server.close();
  });
});
