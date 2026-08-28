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

  it('emits service:status on recording start and stop (#42)', async () => {
    const server = await listen();
    const stream = openEventStream(server.url);
    await new Promise((r) => setTimeout(r, 100));
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'svc' });
    server.services.settings.save({
      recordingDirectory: '',
      maxConcurrentRecordings: 2,
      quality: 'original',
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      dedupeWindowMinutes: 30,
    });

    const countFrames = () => stream.frames.filter((f) => f.includes('event: service:status'));
    expect(countFrames().length).toBe(0);

    await server.services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await new Promise((r) => setTimeout(r, 100));
    expect(countFrames().length).toBeGreaterThanOrEqual(1);
    const startFrame = countFrames()[0]!;
    expect(startFrame).toContain('"activeRecordings":1');

    await server.services.manager.stopRecording(room.id);
    // FakeClock 定时器需 advance 才会让引擎循环走到 stopped 分支并完成。
    (server.services.clock as FakeClock).advance(1000);
    await new Promise((r) => setTimeout(r, 200));
    const frames = countFrames();
    expect(frames.some((f) => f.includes('"activeRecordings":0'))).toBe(true);

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

  it('keeps the recorder active when preview WS and SSE clients disconnect (#84)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/84', displayName: 'lifecycle' });

    await server.services.manager.maybeStartRecording(room, { streamSessionId: 'session-84' });
    expect(server.services.manager.isRoomActive(room.id)).toBe(true);
    expect(server.services.rooms.get(room.id)!.monitorState).toBe('recording');

    const preview = connect(server.url, room.id);
    await preview.opened;
    const events = openEventStream(server.url);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 页面卸载会关闭预览 WS；路由切换也会销毁 SSE。两者均只能回收客户端，
    // 不得影响后台录制会话。
    preview.ws.close();
    await preview.closed;
    events.req.destroy();
    await events.done;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.services.manager.isRoomActive(room.id)).toBe(true);
    expect(server.services.rooms.get(room.id)!.monitorState).toBe('recording');
    expect(server.services.recordings.activeCount()).toBe(1);

    await server.services.manager.stopRecording(room.id);
    (server.services.clock as FakeClock).advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('replays buffered stream header to late-joining clients (FLV preview init)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'buf' });
    server.services.rooms.setState(room.id, 'recording');

    // 录制开始、尚无预览客户端时也需累积流头缓冲（中途加入可初始化 FLV）。
    const header = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01]), Buffer.alloc(256)]);
    server.preview.broadcastFrame(room.id, header);
    server.preview.broadcastFrame(room.id, Buffer.alloc(128));

    // 中途加入的新客户端应首先收到已缓冲的流头数据。
    const c2 = connect(server.url, room.id);
    const firstChunk = await new Promise<Buffer>((resolve) => {
      c2.ws.once('message', (data: Buffer) => resolve(Buffer.from(data)));
    });
    expect(firstChunk.length).toBeGreaterThan(0);
    expect(firstChunk[0]).toBe(0x46);
    expect(firstChunk[1]).toBe(0x4c);
    expect(firstChunk[2]).toBe(0x56);

    c2.ws.close();
    await c2.closed;
    await server.close();
  });
});
