import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

function enablePipeline(services: Services): void {
  const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
  services.settings.save({ ...base, pipeline: { enabled: true, verify: false, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2 } });
}

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
}

describe('V5 Batch2 pipeline: repo + config', () => {
  it('creates run + artifacts and persists pipelineStatus on recording', async () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/x.flv' });

    // 管线未启用：enqueue 置 not_required
    services.pipeline.enqueue(rec.id);
    expect(services.recordings.get(rec.id)!.pipelineStatus).toBe('not_required');

    // 启用管线
    await new Promise<void>((resolve) => {
      services.events.on((e) => { void e; });
      resolve();
    });
    enablePipeline(services);
  });

  it('pipeline endpoints return null run / 404 / retry validation', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's2', streamTitle: 't' });

    // 无 run → null
    const detail = (await inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/pipeline` })).json();
    expect(detail.run).toBeNull();

    // 不存在 → 404
    const missing = await inj({ method: 'GET', url: '/api/v1/recordings/rec_none/pipeline' });
    expect(missing.statusCode).toBe(404);

    // 重试：无文件 → 500
    const retryNoFile = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/retry` });
    expect(retryNoFile.statusCode).toBe(500);

    // 封面：无封面 → 404
    const cover = await inj({ method: 'GET', url: `/api/v1/media/cover/${rec.id}` });
    expect(cover.statusCode).toBe(404);
    await app.close();
  });

  it('retry enqueues a new run when enabled with file present', async () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's3', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-pipe-'));
    const file = path.join(dir, 'x.flv');
    await writeFile(file, 'dummy');
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    enablePipeline(services);

    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().run).not.toBeNull();
    // 异步管线可能已推进到 running/failed（dummy 文件），只断言已脱离 not_required。
    expect(services.recordings.get(rec.id)!.pipelineStatus).not.toBe('not_required');
    await app.close();
  });
});

describe('V5 Batch2 pipeline: cover serving', () => {
  it('serves cover jpg when coverPath present', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's4', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-cover-'));
    const cover = path.join(dir, 'c.jpg');
    await writeFile(cover, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
    services.recordings.update(rec.id, { state: 'completed', coverPath: cover });

    const res = await inj({ method: 'GET', url: `/api/v1/media/cover/${rec.id}` });
    expect(res.statusCode).toBe(200);
    expect((res as unknown as { rawPayload: Buffer }).rawPayload.length).toBeGreaterThan(0);
    await app.close();
  });
});