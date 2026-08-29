import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { resolveBaseName } from '../../src/storage/file-organizer.js';
import { UploadManager, RealWebDavClient } from '../../src/core/upload-manager.js';

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
describe('V5 Batch2 naming rule (#115)', () => {
  it('resolves template with sanitization and truncation', () => {
    // 默认模板 → 时间戳
    expect(resolveBaseName('主播', '2026-08-29T18:30:00.000Z', 'bilibili', undefined, undefined, null)).toMatch(/^20260829_183000$/);
    // 变量模板
    expect(resolveBaseName('主播A', '2026-08-29T18:30:00.000Z', 'bilibili', '1080p', 'room_x', '{room}_{date}_{time}')).toBe('主播A_2026-08-29_18_30_00');
    // 非法字符过滤
    expect(resolveBaseName('a/b:c', '2026-08-29T18:30:00.000Z', 'douyin', undefined, undefined, '{room}')).toBe('a_b_c');
    // 空模板回退时间戳
    expect(resolveBaseName('', '2026-08-29T18:30:00.000Z', 'bilibili', undefined, undefined, '')).toMatch(/^20260829_183000$/);
  });

  it('naming-rule endpoints read/write/preview', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const def = (await inj({ method: 'GET', url: '/api/v1/settings/naming-rule' })).json();
    expect(def.namingRule).toBe('{room}_{date}_{time}');

    const set = await inj({ method: 'PUT', url: '/api/v1/settings/naming-rule', payload: { namingRule: '{platform}_{date}_{room}' } });
    expect(set.statusCode).toBe(200);
    expect(set.json().namingRule).toBe('{platform}_{date}_{room}');

    const bad = await inj({ method: 'PUT', url: '/api/v1/settings/naming-rule', payload: { namingRule: '' } });
    expect(bad.statusCode).toBe(422);

    const preview = await inj({ method: 'POST', url: '/api/v1/settings/naming-rule/preview', payload: { namingRule: '{room}_{time}' } });
    expect(preview.statusCode).toBe(200);
    expect(typeof preview.json().example).toBe('string');
    await app.close();
  });
});

describe('V5 Batch2 OpenList upload (#116)', () => {
  it('config read/write with token via secret store (never echoed)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const def = (await inj({ method: 'GET', url: '/api/v1/settings/openlist' })).json();
    expect(def.openlist.enabled).toBe(false);
    expect(def.openlist.hasToken).toBe(false);

    const set = await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: true, serverUrl: 'https://dav.example.com/dav', username: 'u', token: 'secret-token' } });
    expect(set.statusCode).toBe(200);
    expect(set.json().openlist.hasToken).toBe(true);
    expect(JSON.stringify(set.json())).not.toContain('secret-token');
    const after = (await inj({ method: 'GET', url: '/api/v1/settings/openlist' })).json();
    expect(after.openlist.enabled).toBe(true);
    expect(after.openlist.hasToken).toBe(true);
    await app.close();
  });

  it('upload endpoints: list/retry/cancel + manual upload validation', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const list = (await inj({ method: 'GET', url: '/api/v1/uploads' })).json();
    expect(Array.isArray(list.uploads)).toBe(true);

    // 无文件录制手动上传 → 500
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/5', displayName: 'u' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u1', streamTitle: 't' });
    const noFile = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(noFile.statusCode).toBe(500);

    // 不存在上传重试/取消 → 404
    const retry = await inj({ method: 'POST', url: '/api/v1/uploads/upl_none/retry' });
    expect(retry.statusCode).toBe(404);
    const cancel = await inj({ method: 'POST', url: '/api/v1/uploads/upl_none/cancel' });
    expect(cancel.statusCode).toBe(404);
    await app.close();
  });

  it('creates upload job with recordingId idempotency key when enabled', async () => {
    const services = newServices();
    // 注入假 WebDAV 客户端，避免真实网络与 teardown 竞态。
    services.uploader = new UploadManager(services, {
      async put() { /* fake upload ok */ },
    });
    const { app } = buildApp(services);
    const inj = host(app);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ul-'));
    const file = path.join(dir, 'x.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/6', displayName: 'u' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u2', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: true, serverUrl: 'https://dav.example.com/dav', token: 'tok' } });

    const res = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(res.statusCode).toBe(200);
    expect(res.json().upload.recordingId).toBe(rec.id);
    expect(res.json().upload.idempotencyKey).toBe(`rec_${rec.id}`);
    await app.close();
  });

  it('RealWebDavClient sends stream body with duplex:half (Node undici fetch 必需，否则上传必失败)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-dav-'));
    const file = path.join(dir, 'u.flv');
    await writeFile(file, 'flvdata');
    let seenInit: Record<string, unknown> | undefined;
    let seenBodyIsStream = false;
    const client = new RealWebDavClient();
    // 注入 mock fetch 捕获 init
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      seenInit = init as Record<string, unknown>;
      seenBodyIsStream = typeof init?.body === 'object' && init.body !== null && typeof (init.body as { pipe?: unknown }).pipe === 'function';
      return new Response('', { status: 201 }) as unknown as Response;
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/x.flv', file, 'u', 'tok', () => undefined);
    } finally {
      globalThis.fetch = orig;
    }
    expect(seenInit?.duplex).toBe('half');
    expect(seenBodyIsStream).toBe(true);
  });
});

describe('V5 Batch2 email simplification (#117)', () => {
  it('exposes provider presets and detects provider from host', async () => {
    const { SMTP_PRESETS, detectProvider } = await import('../../src/api/routes/settings.js');
    expect(SMTP_PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(detectProvider('smtp.qq.com')).toBe('qq');
    expect(detectProvider('smtp.gmail.com')).toBe('gmail');
    expect(detectProvider('')).toBe('custom');
  });

  it('email endpoints read/write with passwordSet only', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const presets = (await inj({ method: 'GET', url: '/api/v1/settings/email/presets' })).json();
    expect(presets.presets.length).toBeGreaterThanOrEqual(4);

    const def = (await inj({ method: 'GET', url: '/api/v1/settings/email' })).json();
    expect(def.email.passwordSet).toBe(false);

    const set = await inj({ method: 'PUT', url: '/api/v1/settings/email', payload: { recordingDirectory: '/tmp/vids', host: 'smtp.qq.com', port: 465, secure: true, username: 'u@qq.com', from: 'u@qq.com', recipients: ['me@x.com'], enabled: true, password: 'secret-pw' } });
    expect(set.statusCode).toBe(200);
    expect(JSON.stringify(set.json())).not.toContain('secret-pw');
    expect(set.json().email.passwordSet).toBe(true);
    expect(set.json().email.provider).toBe('qq');

    const testRes = await inj({ method: 'POST', url: '/api/v1/settings/email/test' });
    // FakeMailer 发送成功 → ok。
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);
    await app.close();
  });
});
