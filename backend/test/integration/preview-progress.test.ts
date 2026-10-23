import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';

// API 与升级守卫按服务配置端口校验 Host/Origin，与测试实际监听的临时端口无关。
const HOST = { host: '127.0.0.1:43120' };

async function waitForStages(socket: WebSocket, sink: string[], until: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!sink.includes(until) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('直播加载进度（预览启动阶段上报）', () => {
  it('向订阅客户端按阶段推送进度，未订阅的旧协议客户端不收控制帧', async () => {
    const services = buildServices({ dbPath: ':memory:', clock: new FakeClock() });
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-progress-'));
    await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: {
        recordingDirectory: dir, maxConcurrentRecordings: 2, autoRecord: false,
        checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
        retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
        diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
        mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      },
    });
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 'sess_progress', streamTitle: '进度上报', availableQualities: ['original'] },
    ]);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'douyin', url: 'https://live.douyin.com/9010', displayName: '进度上报' },
    });
    const roomId = created.json().room.id;
    await app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/check`, headers: HOST });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };
    const stages: string[] = [];
    const legacy: string[] = [];
    // 监听先于握手完成挂上：补发帧与握手同批到达，open 之后再挂会漏掉首批。
    const connect = async (progress: boolean, sink: string[]) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/preview/${roomId}${progress ? '?progress=1' : ''}`,
        { headers: { host: HOST.host, origin: 'http://127.0.0.1:43120' } },
      );
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message?.type === 'preview_progress') sink.push(message.stage);
        } catch { /* 二进制媒体帧 */ }
      });
      await once(socket, 'open');
      return socket;
    };
    const subscribed = await connect(true, stages);
    const legacySocket = await connect(false, legacy);

    await waitForStages(subscribed, stages, 'source_ready');
    // 阶段单调推进：从请求到首数据就绪，客户端能收到完整阶段链。
    expect(stages).toEqual(expect.arrayContaining([
      'requested', 'platform_cookie_ready', 'stream_url_ready', 'source_ready',
    ]));
    expect(new Set(stages).size).toBe(stages.length);
    expect(legacy).toEqual([]);

    subscribed.close();
    legacySocket.close();
    await app.close();
  }, 30_000);
});
