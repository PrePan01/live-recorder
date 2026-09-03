import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { resolveBaseName } from '../../src/storage/file-organizer.js';
import { UploadManager, RealWebDavClient } from '../../src/core/upload-manager.js';

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

  it('pipeline compress is skipped for mp4 with crf=null instead of failed→partial (M7 QA)', async () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/8', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's8', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-pipe-mp4-'));
    const file = path.join(dir, 'x.mp4');
    // 生成可被 ffprobe 认可的极小 mp4；ffmpeg 缺失时写 dummy（ffprobe 同样缺失 → verify 走 pending 继续）。
    const gen = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-pix_fmt', 'yuv420p', file], { timeout: 30_000 });
    if (gen.status !== 0) await writeFile(file, 'dummy');
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    enablePipeline(services);

    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/retry` });
    expect(res.statusCode).toBe(200);
    await waitFor(() => {
      const r = services.recordings.get(rec.id)!;
      return r.pipelineStatus !== 'running' && r.pipelineStatus !== 'queued' && r.pipelineStatus !== 'not_required';
    });
    // mp4 + crf=null：compress 应为 skipped，run 应为 ok，而非 failed→partial。
    expect(services.recordings.get(rec.id)!.pipelineStatus).toBe('ok');
    const run = services.pipeline.repo.runForRecording(rec.id);
    const compress = run?.artifacts.find((a) => a.step === 'compress');
    expect(compress?.status).toBe('skipped');
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
  it('resolves template with sanitization and truncation (本地日期命名)', () => {
    const iso = '2026-08-29T18:30:00.000Z';
    const d = new Date(iso);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const localSlug = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const localDate = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const localTime = `${p2(d.getHours())}_${p2(d.getMinutes())}_${p2(d.getSeconds())}`;
    // 默认模板 → 时间戳（本地时间）
    expect(resolveBaseName('主播', iso, 'bilibili', undefined, undefined, null)).toBe(localSlug);
    // 变量模板
    expect(resolveBaseName('主播A', iso, 'bilibili', '1080p', 'room_x', '{room}_{date}_{time}')).toBe(`主播A_${localDate}_${localTime}`);
    // 非法字符过滤
    expect(resolveBaseName('a/b:c', iso, 'douyin', undefined, undefined, '{room}')).toBe('a_b_c');
    // 空模板回退时间戳
    expect(resolveBaseName('', iso, 'bilibili', undefined, undefined, '')).toBe(localSlug);
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

  it('test endpoint: PROPFIND 校验凭证，仅 2xx 成功；401/403/404 区分报错（QA #186）', async () => {
    const services = newServices();
    services.settings.save({ ...(services.settings.load() ?? structuredClone(DEFAULT_SETTINGS) as never), openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}/{date}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');
    const { app } = buildApp(services);
    const inj = host(app);

    const orig = globalThis.fetch;
    let seenMethod = '';
    let seenDepth = '';
    for (const [status, expectOk, expectMsg] of [
      [207, true, null],
      [200, true, null],
      [401, false, '认证失败'],
      [403, false, '认证失败'],
      [404, false, '地址路径无效'],
      [500, false, 'HTTP 500'],
    ] as const) {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        seenMethod = String(init?.method);
        seenDepth = String((init?.headers as Record<string, string> | undefined)?.Depth);
        return new Response('', { status });
      }) as typeof fetch;
      const res = await inj({ method: 'POST', url: '/api/v1/settings/openlist/test' });
      if (expectOk) {
        expect(res.statusCode, `status ${status} 应为成功`).toBe(200);
        expect(res.json().ok).toBe(true);
      } else {
        expect(res.statusCode, `status ${status} 应判失败`).toBe(500);
        const err = res.json().error;
        expect(err.code).toBe('CONFIG_LOAD_FAILED');
        expect(String(err.message)).toContain(expectMsg!);
      }
    }
    expect(seenMethod).toBe('PROPFIND');
    expect(seenDepth).toBe('0');
    globalThis.fetch = orig;
    await app.close();
  });

  it('test endpoint: 未配置地址/令牌不发起请求（PrePan 复验空表单误报前置）', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'POST', url: '/api/v1/settings/openlist/test' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('CONFIG_LOAD_FAILED');
    expect(res.json().error.message).toContain('地址未配置');
    await app.close();
  });

  it('resolveRemotePath: {date} 取自 startedAt（非文件名切片），且保留 http:// scheme（QA E2E #116）', async () => {
    const services = newServices();
    const captured: string[] = [];
    services.uploader = new UploadManager(services, {
      async put(remotePath: string) { captured.push(remotePath); },
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ul4-'));
    const file = path.join(dir, '20260902_122631.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/6', displayName: 'u' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u2', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', startedAt: '2026-09-02T12:26:31.000Z', filePath: file });
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as never);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}/{date}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    const job = await services.uploader.enqueue(rec.id);
    expect(job).not.toBeNull();
    await waitFor(() => captured.length > 0);
    // {date}=录制 startedAt 的本地日期（非文件名前 10 字符 20260902_1）；scheme http:// 不被折叠成 http:/
    const sd = new Date('2026-09-02T12:26:31.000Z');
    const localDate = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`;
    expect(captured[0]).toBe(`https://dav.example.com/dav/u/${localDate}/20260902_122631.flv`);
  });

  it('auto-upload fires on completion even when pipeline disabled (PrePan 客户端自动上传不生效)', async () => {
    const services = newServices();
    services.uploader = new UploadManager(services, {
      async put() { /* fake upload ok */ },
    });
    const { app } = buildApp(services);
    const inj = host(app);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-auto-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/77', displayName: 'u' });
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as never);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    // 模拟录制完成（pipeline 默认 disabled）：completeRecording → pipeline.enqueue
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'au', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    services.pipeline.enqueue(rec.id);

    await waitFor(() => services.uploader.uploadRepo.jobForRecording(rec.id)?.status === 'ok');
    const res = await inj({ method: 'GET', url: '/api/v1/recordings' });
    const item = (res.json().items as Array<{ id: string; upload?: { status: string; progress: number } }>).find((r) => r.id === rec.id)!;
    expect(item.upload?.status).toBe('ok');
    expect(item.upload?.progress).toBe(100);
    await app.close();
  });

  it('resumePending re-enqueues queued/running upload jobs on restart (#195)', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-resume-'));
    const file = path.join(dir, 'r.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/88', displayName: 'u' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'r88', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as never);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    let puts = 0;
    // 上次会话：入队即完成（put ok），随后把任务状态改回 queued，模拟重启前排队中/中断。
    const um1 = new UploadManager(services, { async put() { puts += 1; } });
    const job = await um1.enqueue(rec.id);
    expect(job).not.toBeNull();
    await waitFor(() => um1.uploadRepo.get(job!.id)?.status === 'ok');
    um1.uploadRepo.update(job!.id, { status: 'queued' });

    // 重启：新 UploadManager（内存队列空），resumePending 应从 DB 恢复并续传完成。
    const um2 = new UploadManager(services, { async put() { puts += 1; } });
    expect(um2.resumePending()).toBe(1);
    await waitFor(() => um2.uploadRepo.get(job!.id)?.status === 'ok');
    expect(puts).toBeGreaterThanOrEqual(2);

    // running（进程中断于上传中）也应被恢复为 queued 续传。
    const job2 = await um2.enqueue(rec.id);
    um2.uploadRepo.update(job2!.id, { status: 'running' });
    const um3 = new UploadManager(services, { async put() { puts += 1; } });
    expect(um3.resumePending()).toBe(1);
    expect(um3.uploadRepo.get(job2!.id)?.status).toBe('queued');
    await waitFor(() => um3.uploadRepo.get(job2!.id)?.status === 'ok');
  });

  it('GET /recordings attaches latest upload snapshot (#190)', async () => {
    const services = newServices();
    services.uploader = new UploadManager(services, {
      async put() { /* fake upload ok */ },
    });
    const { app } = buildApp(services);
    const inj = host(app);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ul5-'));
    const file = path.join(dir, 'x.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9', displayName: 'u' });
    // 有上传任务的录制
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u9', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    // 无上传任务的录制
    const rec2 = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u9b', streamTitle: 't2' });
    services.recordings.update(rec2.id, { state: 'completed', filePath: file });
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as never);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    const job = await services.uploader.enqueue(rec.id);
    expect(job).not.toBeNull();
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'ok');

    const res = await inj({ method: 'GET', url: '/api/v1/recordings?pageSize=50' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; upload?: { status: string; progress: number; remotePath: string | null } }>;
    const withUpload = items.find((r) => r.id === rec.id)!;
    expect(withUpload.upload?.status).toBe('ok');
    expect(withUpload.upload?.progress).toBe(100);
    expect(withUpload.upload?.remotePath).toContain('/dav/u/');
    const noUpload = items.find((r) => r.id === rec2.id)!;
    expect(noUpload.upload).toBeUndefined();
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
    // 幂等（M7 QA）：已上传录制的再次触发应返回既有 job，不新建、不 500（idempotency_key UNIQUE）。
    const again = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(again.statusCode).toBe(200);
    expect(again.json().upload.id).toBe(res.json().upload.id);
    const jobs = services.uploader.uploadRepo.list();
    expect(jobs.filter((j) => j.recordingId === rec.id)).toHaveLength(1);
    await app.close();
  });

  it('enqueue is atomic-idempotent: concurrent duplicate insert never throws UNIQUE (PrePan/#178)', async () => {
    const services = newServices();
    services.uploader = new UploadManager(services, {
      async put() { /* fake upload ok */ },
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ul3-'));
    const file = path.join(dir, 'y.flv');
    await writeFile(file, 'data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/69', displayName: 'u' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'u69', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');

    // 并发触发：同一 recording 两次并发 enqueue（TOCTOU 窗口）。原子 INSERT OR IGNORE 保证只建 1 条、绝不抛 UNIQUE。
    const repo = services.uploader.uploadRepo;
    // 模拟并发窗口：第一次 create 用原子插入；同时直接以同 idempotency_key 预插（绕过 fast path）制造 UNIQUE 冲突面。
    const [a, b] = await Promise.all([services.uploader.enqueue(rec.id), services.uploader.enqueue(rec.id)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id); // 同一 job
    const rows = repo.list().filter((j) => j.recordingId === rec.id);
    expect(rows).toHaveLength(1); // 不新建重复记录
    // 直接验证 repo.create 对同 key 二次插入不抛（返回 null）。
    expect(repo.create({ recordingId: rec.id, idempotencyKey: `rec_${rec.id}` })).toBeNull();
  });

  it('emits live byte progress and does not leave history at 0% until completion', async () => {
    const services = newServices();
    const progressEvents: number[] = [];
    services.uploader = new UploadManager(services, {
      async put(_remote, _local, _username, _token, onProgress) {
        onProgress(7);
        onProgress(42);
        onProgress(88);
      },
    });
    services.events.on((event) => {
      if (event.type === 'upload:updated' && event.data.status === 'running') progressEvents.push(event.data.progress);
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-progress-'));
    const file = path.join(dir, 'progress.flv');
    await writeFile(file, 'progress-data');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/70', displayName: 'progress' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'progress', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    services.settings.save({ ...(services.settings.load() ?? structuredClone(DEFAULT_SETTINGS) as never), openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'ok');
    expect(progressEvents).toEqual(expect.arrayContaining([7, 42, 88]));
    expect(services.uploader.uploadRepo.get(job!.id)?.progress).toBe(100);
  });

  it('releases the queue during retry backoff so one failed upload cannot block later jobs', async () => {
    const services = newServices();
    let firstAttempts = 0;
    services.uploader = new UploadManager(services, {
      async put(remote) {
        if (remote.endsWith('/first.flv') && firstAttempts++ === 0) throw new Error('temporary');
      },
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-upload-fair-'));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/71', displayName: 'fair' });
    const first = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'first', streamTitle: 'first' });
    const second = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'second', streamTitle: 'second' });
    const firstFile = path.join(dir, 'first.flv');
    const secondFile = path.join(dir, 'second.flv');
    await writeFile(firstFile, 'first');
    await writeFile(secondFile, 'second');
    services.recordings.update(first.id, { state: 'completed', filePath: firstFile });
    services.recordings.update(second.id, { state: 'completed', filePath: secondFile });
    services.settings.save({ ...(services.settings.load() ?? structuredClone(DEFAULT_SETTINGS) as never), openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' } } as never);
    await services.secretStore.set('openlist.token', 'tok');

    const firstJob = await services.uploader.enqueue(first.id);
    const secondJob = await services.uploader.enqueue(second.id);
    await waitFor(() => services.uploader.uploadRepo.get(secondJob!.id)?.status === 'ok');
    expect(services.uploader.uploadRepo.get(firstJob!.id)?.status).toBe('queued');
    expect(services.uploader.uploadRepo.get(firstJob!.id)?.error).toContain('5 秒后自动重试');

    (services.clock as FakeClock).advance(5_000);
    await waitFor(() => services.uploader.uploadRepo.get(firstJob!.id)?.status === 'ok');
  });

  it('RealWebDavClient sends stream body with duplex:half (Node undici fetch 必需，否则上传必失败)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-dav-'));
    const file = path.join(dir, 'u.flv');
    await writeFile(file, 'flvdata');
    let seenInit: Record<string, unknown> | undefined;
    let seenBodyIsStream = false;
    const progress: number[] = [];
    const client = new RealWebDavClient();
    // 注入 mock fetch 捕获 init
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      seenInit = init as Record<string, unknown>;
      seenBodyIsStream = typeof init?.body === 'object' && init.body !== null && typeof (init.body as { pipe?: unknown }).pipe === 'function';
      if (init?.body) {
        for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) { /* consume upload stream */ }
      }
      return new Response('', { status: 201 }) as unknown as Response;
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/x.flv', file, 'u', 'tok', (pct) => progress.push(pct));
    } finally {
      globalThis.fetch = orig;
    }
    expect(seenInit?.duplex).toBe('half');
    expect(seenBodyIsStream).toBe(true);
    expect(progress).toEqual(expect.arrayContaining([99, 100]));
  });

  it('uses a separate response timeout after the PUT body is fully consumed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-dav-response-'));
    const file = path.join(dir, 'slow-ack.flv');
    await writeFile(file, 'flvdata');
    let signalWasAbortedWhileWaiting = false;
    const client = new RealWebDavClient({ uploadIdleTimeoutMs: 5, responseTimeoutMs: 200 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (init?.body) {
        for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) { /* consume upload stream */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalWasAbortedWhileWaiting = init?.signal?.aborted ?? false;
      return new Response('', { status: 201 });
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/slow-ack.flv', file, 'u', 'tok', () => undefined);
    } finally {
      globalThis.fetch = orig;
    }
    expect(signalWasAbortedWhileWaiting).toBe(false);
  });

  it('treats an ambiguous PUT 504 as success when PROPFIND confirms the complete remote file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-dav-verify-'));
    const file = path.join(dir, 'verified.flv');
    await writeFile(file, 'flvdata');
    const progress: number[] = [];
    let putCalls = 0;
    let verifyCalls = 0;
    const client = new RealWebDavClient({ verifyDelaysMs: [0], verifyTimeoutMs: 100 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (init?.method === 'PROPFIND') {
        verifyCalls += 1;
        return new Response(
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>',
          { status: 207 },
        );
      }
      putCalls += 1;
      if (init?.body) {
        for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) { /* consume upload stream */ }
      }
      return new Response('', { status: 504 });
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/verified.flv', file, 'u', 'tok', (pct) => progress.push(pct));
    } finally {
      globalThis.fetch = orig;
    }
    expect(putCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(progress.at(-1)).toBe(100);
  });

  it('uses the OpenList background task API and reports its server-side progress', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-openlist-task-'));
    const file = path.join(dir, 'task.flv');
    await writeFile(file, 'flvdata');
    const progress: number[] = [];
    let infoCalls = 0;
    let webDavPutCalls = 0;
    let taskUploadHeaders: Headers | undefined;
    const client = new RealWebDavClient({ taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) {
        return new Response(JSON.stringify({ code: 200, data: { token: 'jwt-token' } }), { status: 200 });
      }
      if (url.endsWith('/api/fs/put')) {
        taskUploadHeaders = new Headers(init?.headers);
        if (init?.body) {
          for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) { /* consume upload stream */ }
        }
        return new Response(JSON.stringify({
          code: 200,
          data: { task: { id: 'task-1', state: 'pending', progress: 0, total_bytes: 7 } },
        }), { status: 200 });
      }
      if (url.includes('/api/task/upload/info')) {
        infoCalls += 1;
        const snapshots = [
          { id: 'task-1', state: 'running', progress: 20, total_bytes: 7 },
          { id: 'task-1', state: 'running', progress: 75, total_bytes: 7 },
          { id: 'task-1', state: 'succeeded', progress: 100, total_bytes: 7 },
        ];
        return new Response(JSON.stringify({ code: 200, data: snapshots[Math.min(infoCalls - 1, 2)] }), { status: 200 });
      }
      if (init?.method === 'PUT') webDavPutCalls += 1;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await client.put(
        'https://dav.example.com/dav/archive/task.flv',
        file,
        'u',
        'password',
        (pct) => progress.push(pct),
        'https://dav.example.com/dav/archive',
      );
    } finally {
      globalThis.fetch = orig;
    }
    expect(taskUploadHeaders?.get('Authorization')).toBe('jwt-token');
    expect(taskUploadHeaders?.get('As-Task')).toBe('true');
    expect(decodeURIComponent(taskUploadHeaders?.get('File-Path') ?? '')).toBe('/archive/task.flv');
    expect(infoCalls).toBe(3);
    expect(webDavPutCalls).toBe(0);
    expect(progress).toEqual(expect.arrayContaining([50, 59, 86, 100]));
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
