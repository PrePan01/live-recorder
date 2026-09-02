import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';

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

  it('returns CORS headers for cross-origin EventSource (#140 SSE gap)', async () => {
    const server = await listen();
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(`${server.url}/api/v1/events`, { headers: { Host: '127.0.0.1:43120', Origin: 'http://tauri.localhost' } }, (res) => {
        resolve(res.headers);
        req.destroy();
      });
      req.on('error', reject);
    });
    expect(headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    expect(headers['access-control-allow-methods']).toContain('GET');
    expect(headers['vary']).toBe('Origin');
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

  it('accepts preview for a live-but-idle room and starts preview-only stream without recording (#163 预览不落盘)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/150', displayName: 'livePreview' });
    server.services.rooms.setLiveStatus(room.id, 'live');
    (server.services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 's150', streamTitle: 'T' }]);
    expect(server.services.manager.isRoomActive(room.id)).toBe(false);

    const { ws, opened, closed } = connect(server.url, room.id);
    await opened; // 开播但未录制：不再 4002，而是接受连接
    // 预览专用拉流启动（不触发录制、不落盘）。
    for (let i = 0; i < 20 && !server.services.manager.isPreviewStreaming(room.id); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(server.services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(server.services.manager.isRoomActive(room.id)).toBe(false); // 未触发录制
    // 断开最后一个客户端 → 预览拉流停止。
    ws.close();
    await closed;
    for (let i = 0; i < 20 && server.services.manager.isPreviewStreaming(room.id); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(server.services.manager.isPreviewStreaming(room.id)).toBe(false);
    await server.close();
  });

  it('accepts when recording, broadcasts frames, enforces 4-session limit, closes with stream_end', async () => {
    const server = await listen();
    const rooms = [
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'a' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'b' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: 'c' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 'd' }),
      server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/5', displayName: 'e' }),
    ];
    for (const r of rooms) server.services.rooms.setState(r.id, 'recording');

    // 4 个会话（房间）可并接受；同一房间第二个 socket 共享会话不占额外配额。
    const c1 = connect(server.url, rooms[0]!.id);
    await c1.opened;
    const c1b = connect(server.url, rooms[0]!.id);
    await c1b.opened;
    const c2 = connect(server.url, rooms[1]!.id);
    await c2.opened;
    const c3 = connect(server.url, rooms[2]!.id);
    await c3.opened;
    const c4 = connect(server.url, rooms[3]!.id);
    await c4.opened;
    // 第 5 个会话 → 4003 超限降级。
    const c5 = connect(server.url, rooms[4]!.id);
    expect(await c5.closed).toBe(4003);

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

    c1b.ws.close();
    await c1b.closed;
    c2.ws.close();
    await c2.closed;
    c3.ws.close();
    await c3.closed;
    c4.ws.close();
    await c4.closed;
    await server.close();
  });

  it('replays buffered stream header to late-joining clients (FLV preview init)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'buf' });
    server.services.rooms.setState(room.id, 'recording');

    // 录制开始、尚无预览客户端时也需累积流头缓冲（中途加入可初始化 FLV）。
    const header = buildFlvInit();
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

  it('keeps preview header across client disconnects during active stream (#193 重开预览卡连接视频流)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'persist' });
    server.services.rooms.setState(room.id, 'recording');

    const init = buildFlvInit();
    server.preview.broadcastFrame(room.id, init);

    const c1 = connect(server.url, room.id);
    const first1 = await new Promise<Buffer>((resolve) => c1.ws.once('message', (d) => resolve(Buffer.from(d))));
    expect(first1.subarray(0, 3).toString()).toBe('FLV');
    c1.ws.close();
    await c1.closed;

    // 录制仍在继续：广播近期媒体数据（非 FLV 头）。
    server.preview.broadcastFrame(room.id, Buffer.from([0xaa, 0xbb, 0xcc]));

    // 客户端断开后再重开预览：新客户端先收到流头（FLV 签名），再收到近期尾部（接近实时位置的媒体）。
    const c2 = connect(server.url, room.id);
    const c2msgs: Buffer[] = [];
    c2.ws.on('message', (d: Buffer) => c2msgs.push(Buffer.from(d)));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (c2msgs.length >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const first2 = c2msgs[0]!;
    expect(first2.subarray(0, 3).toString()).toBe('FLV');
    const tail2 = c2msgs[1]!;
    expect([...tail2]).toEqual([0xaa, 0xbb, 0xcc]);
    c2.ws.close();
    await c2.closed;
    await server.close();
  });
it('init extractor completes at first media when audio seq missing (#193 QA 边角)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: 'noaudio' });
    server.services.rooms.setState(room.id, 'recording');

    const h = Buffer.alloc(13);
    h.write('FLV', 0);
    h[3] = 1;
    h[4] = 0x05;
    h.writeUInt32BE(9, 5);
    h.writeUInt32BE(0, 9);
    const meta = flvTag(18, Buffer.alloc(4));
    const vseq = flvTag(9, Buffer.from([0x17, 0x00, 0x01, 0x02]));
    const media = flvTag(9, Buffer.from([0x17, 0x01, 0xde, 0xad]));
    server.preview.broadcastFrame(room.id, h);
    server.preview.broadcastFrame(room.id, meta);
    server.preview.broadcastFrame(room.id, vseq);
    server.preview.broadcastFrame(room.id, media);

    const c = connect(server.url, room.id);
    const first = await new Promise<Buffer>((resolve) => c.ws.once('message', (d) => resolve(Buffer.from(d))));
    expect(first.subarray(0, 3).toString()).toBe('FLV');
    // init = 13(FLV头) + 19(onMetaData) + 19(AVC seq)，不含首个媒体帧。
    expect(first.length).toBe(51);
    c.ws.close();
    await c.closed;
    await server.close();
  });
it('tail replay starts at a video keyframe for mid-join clients (FE 定位 P 帧开头卡第一秒)', async () => {
    const server = await listen();
    const room = server.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 'keyframe' });
    server.services.rooms.setState(room.id, 'recording');

    server.preview.broadcastFrame(room.id, buildFlvInit());
    // 大量非关键帧（每个 ~200KB）撑破 1MB 尾部，随后一个关键帧，再若干非关键帧。
    for (let i = 0; i < 7; i += 1) server.preview.broadcastFrame(room.id, buildVideoTag(2, 200_000));
    server.preview.broadcastFrame(room.id, buildVideoTag(1, 50_000));
    for (let i = 0; i < 3; i += 1) server.preview.broadcastFrame(room.id, buildVideoTag(2, 50_000));

    // 晚加入客户端：收到 [init] + [tail]，tail 首个视频标签必须是关键帧（frameType==1）。
    const c = connect(server.url, room.id);
    const msgs: Buffer[] = [];
    c.ws.on('message', (d: Buffer) => msgs.push(Buffer.from(d)));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (msgs.length >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const init = msgs[0]!;
    const tail = msgs[1]!;
    expect(init.subarray(0, 3).toString()).toBe('FLV');
    let off = 0;
    let firstVideoFrameType: number | null = null;
    while (off + 15 <= tail.length) {
      const type = tail[off]!;
      const ds = (tail[off + 1]! << 16) | (tail[off + 2]! << 8) | tail[off + 3]!;
      if (off + 11 + ds + 4 > tail.length) break;
      if (type === 9) {
        firstVideoFrameType = tail[off + 11]! >> 4;
        break;
      }
      off += 11 + ds + 4;
    }
    expect(firstVideoFrameType).toBe(1);
    c.ws.close();
    await c.closed;
    await server.close();
  });
});

function buildVideoTag(frameType: number, payloadSize: number): Buffer {
  const data = Buffer.alloc(payloadSize);
  data[0] = (frameType << 4) | 7;
  data[1] = 1;
  return flvTag(9, data);
}
function buildFlvInit(): Buffer {
  const h = Buffer.alloc(13);
  h.write('FLV', 0);
  h[3] = 1;
  h[4] = 0x05;
  h.writeUInt32BE(9, 5);
  h.writeUInt32BE(0, 9);
  const meta = flvTag(18, Buffer.alloc(4));
  const vseq = flvTag(9, Buffer.from([0x17, 0x00, 0x01, 0x02]));
  const aseq = flvTag(8, Buffer.from([0xaf, 0x00, 0x01, 0x02]));
  return Buffer.concat([h, meta, vseq, aseq]);
}

function flvTag(type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header[0] = type;
  const size = data.length;
  header[1] = (size >> 16) & 0xff;
  header[2] = (size >> 8) & 0xff;
  header[3] = size & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + size, 0);
  return Buffer.concat([header, data, prev]);
}
