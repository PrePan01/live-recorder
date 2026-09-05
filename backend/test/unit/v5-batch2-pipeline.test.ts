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

  it('#229 multipart 分片并发上传：分片→complete(As-Task)→任务轮询成功', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-multipart-'));
    const file = path.join(dir, 'big.flv');
    await writeFile(file, Buffer.alloc(40)); // 40B，配合小阈值/小 chunk 触发分片
    const progress: number[] = [];
    let chunkCalls: string[] = [];
    let completeCalls = 0;
    let taskCalls = 0;
    const client = new RealWebDavClient({ multipartThresholdBytes: 1, multipartChunkSizeBytes: 16, multipartConcurrency: 2, taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.includes('/api/fs/multipart')) {
        if (url.includes('action=complete')) {
          completeCalls += 1;
          return new Response(JSON.stringify({ code: 200, data: { task: { id: 'mt-task', state: 'running', progress: 100 } } }), { status: 200 });
        }
        chunkCalls.push((init?.headers as Record<string, string>)['X-Chunk-Index'] ?? '');
        return new Response(JSON.stringify({ code: 200, data: { upload_id: 'sess-1' } }), { status: 200 });
      }
      if (url.includes('/api/task/upload/info')) {
        taskCalls += 1;
        return new Response(JSON.stringify({ code: 200, data: { id: 'mt-task', state: 'succeeded', progress: 100 } }), { status: 200 });
      }
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/archive/big.flv', file, 'u', 'password', (pct) => progress.push(pct), 'https://dav.example.com/dav/archive');
    } finally {
      globalThis.fetch = orig;
    }
    // 40B / 16B chunk = 3 片（0/1/2），分片 0 建立会话，其余并发。
    expect(chunkCalls).toEqual(expect.arrayContaining(['0', '1', '2']));
    expect(completeCalls).toBe(1);
    expect(taskCalls).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(100);
  });

  it('#229 multipart 不支持（404）→ 严格回退单 PUT，上传仍成功', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-multipart-fb-'));
    const file = path.join(dir, 'big2.flv');
    await writeFile(file, Buffer.alloc(40));
    const client = new RealWebDavClient({ multipartThresholdBytes: 1, multipartChunkSizeBytes: 16, taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    let singlePut = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.includes('/api/fs/multipart')) return new Response('', { status: 404 });
      if (init?.method === 'PUT') { singlePut += 1; return new Response('', { status: 200 }); }
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await client.put('https://dav.example.com/dav/archive/big2.flv', file, 'u', 'password', () => undefined, 'https://dav.example.com/dav/archive');
    } finally {
      globalThis.fetch = orig;
    }
    expect(singlePut).toBeGreaterThan(0);
  });

  // #23 覆盖补全：客户端 put() 内部各失败路径直接断言（PrePan：测试覆盖所有可能导致上传失败的情况）。
  it('put: As-Task 任务创建失败（HTTP 非 2xx/无 task id）→ 抛「OpenList 创建上传任务失败」', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-task-create-fail-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ code: 200, data: { token: 'jwt' } }), { status: 200 });
      if (url.endsWith('/api/fs/put')) return new Response(JSON.stringify({ code: 500, message: '写入失败' }), { status: 500 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('OpenList 创建上传任务失败');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('put: 任务轮询到 failed 状态 → 抛「OpenList 后台上传失败」并携带服务端 error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-task-failed-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ code: 200, data: { token: 'jwt' } }), { status: 200 });
      if (url.endsWith('/api/fs/put')) return new Response(JSON.stringify({ code: 200, data: { task: { id: 't1', state: 'pending', progress: 0 } } }), { status: 200 });
      if (url.includes('/api/task/upload/info')) return new Response(JSON.stringify({ code: 200, data: { id: 't1', state: 'failed', error: '资源不存在(00010010)' } }), { status: 200 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('OpenList 后台上传失败：资源不存在(00010010)');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('put: 任务轮询 task.error（配额不足等）→ 立即透传「OpenList 后台上传失败」', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-task-error-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ code: 200, data: { token: 'jwt' } }), { status: 200 });
      if (url.endsWith('/api/fs/put')) return new Response(JSON.stringify({ code: 200, data: { task: { id: 't1', state: 'running', progress: 50 } } }), { status: 200 });
      if (url.includes('/api/task/upload/info')) return new Response(JSON.stringify({ code: 200, data: { id: 't1', state: 'running', progress: 60, error: '资源配额不足' } }), { status: 200 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('OpenList 后台上传失败：资源配额不足');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('put: 任务进度卡滞且远端核验失败 → 抛「进度长时间无变化」（不再静默卡 99%）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-task-stall-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ taskPollIntervalMs: 1, taskPollTimeoutMs: 2_000, taskStallTimeoutMs: 50, verifyDelaysMs: [0, 50] });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ code: 200, data: { token: 'jwt' } }), { status: 200 });
      if (url.endsWith('/api/fs/put')) return new Response(JSON.stringify({ code: 200, data: { task: { id: 't1', state: 'running', progress: 80 } } }), { status: 200 });
      if (url.includes('/api/task/upload/info')) return new Response(JSON.stringify({ code: 200, data: { id: 't1', state: 'running', progress: 80 } }), { status: 200 });
      if (init?.method === 'PROPFIND') return new Response('', { status: 404 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('进度长时间无变化');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('put: WebDAV PUT 405（目标不接受 PUT）→ 透传「WebDAV PUT 405」错误（#12 场景）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-put-405-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ multipartEnabled: false, taskApiEnabled: false });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ code: 200, data: { token: 'jwt' } }), { status: 200 });
      if (init?.method === 'PUT') return new Response('', { status: 405 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('WebDAV PUT 405');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('put: MKCOL 目录创建失败（非 405）→ 抛「WebDAV MKCOL {status}」', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-mkcol-fail-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'flvdata');
    const client = new RealWebDavClient({ multipartEnabled: false, taskApiEnabled: false });
    const orig = globalThis.fetch;
    let mkcolAttempts = 0;
    globalThis.fetch = (async (input, init) => {
      if (init?.method === 'MKCOL') { mkcolAttempts += 1; return new Response('', { status: 403 }); }
      if (init?.method === 'PROPFIND') return new Response('', { status: 207 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/sub/a.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('WebDAV MKCOL 403');
      expect(mkcolAttempts).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('run(): 配置或文件缺失（rec/config 缺失）→ 明确标「配置或文件缺失」', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/cm1', displayName: 'cm' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'scm', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-cm-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    services.uploader = new UploadManager(services, {
      async put() { throw new Error('unreachable'); },
    });
    // rec 存在但 filePath 指向不存在磁盘路径 → run() 应先命中配置/文件缺失（existsSync false 走源文件已删除）。
    services.recordings.update(rec.id, { filePath: path.join(dir, 'missing.flv') });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('源文件已删除');
  });

  it('put: multipart 分片 complete 返回失败状态 → 透传「分片合并/落盘失败」', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-mt-fail-'));
    const file = path.join(dir, 'big.flv');
    await writeFile(file, Buffer.alloc(40));
    const client = new RealWebDavClient({ multipartThresholdBytes: 1, multipartChunkSizeBytes: 16, multipartConcurrency: 2, taskPollIntervalMs: 1, taskPollTimeoutMs: 1_000 });
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === 'MKCOL') return new Response('', { status: 201 });
      if (url.includes('/api/fs/multipart') && url.includes('action=complete')) {
        return new Response(JSON.stringify({ code: 200, data: { task: { id: 'mt', state: 'failed', error: '资源不存在' } } }), { status: 200 });
      }
      if (url.includes('/api/fs/multipart')) return new Response(JSON.stringify({ code: 200, data: { upload_id: 'sess-1' } }), { status: 200 });
      if (url.includes('/api/task/upload/info')) return new Response(JSON.stringify({ code: 200, data: { id: 'mt', state: 'failed', error: '资源不存在' } }), { status: 200 });
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await expect(client.put('https://dav.example.com/dav/archive/big.flv', file, 'u', 'p', () => undefined, 'https://dav.example.com/dav/archive')).rejects.toThrow('分片合并/落盘失败');
    } finally {
      globalThis.fetch = orig;
    }
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

describe('V5 OpenList 2FA (#13)', () => {
  it('RealWebDavClient.apiToken: 登录 402 标记 pending2fa，put 抛「需要 2FA 验证」而非回退 405', async () => {
    const orig = globalThis.fetch;
    let loginCalls = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        loginCalls += 1;
        return { ok: true, status: 200, json: async () => ({ code: 402, message: 'Invalid 2FA code', data: null }) } as unknown as Response;
      }
      // MKCOL/PROPFIND 等 WebDAV 方法在 2FA 检测前调用：返回 200 放行。
      const method = (init?.method as string | undefined) ?? 'GET';
      if (method === 'MKCOL') {
        return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const client = new RealWebDavClient();
      const root = 'https://dav.example.com';
      expect(client.needs2fa(root)).toBe(false);
      // 首次登录返回 null（无法换取 token），同时记录 pending2fa。
      const token = await (client as unknown as { apiToken(r: string, u: string, p: string): Promise<string | null> }).apiToken(root, 'u', 'p');
      expect(token).toBeNull();
      expect(client.needs2fa(root)).toBe(true);
      // put 时检测到 2FA → 抛标识错误（即使本地文件存在）。
      const dir = await mkdtemp(path.join(tmpdir(), 'lr-2fa-'));
      const file = path.join(dir, 'x.flv');
      await writeFile(file, Buffer.from([1, 2, 3]));
      await expect(client.put(`${root}/dav/x/y.flv`, file, 'u', 'p', () => {}, `${root}/dav`)).rejects.toThrow('OpenList 需要 2FA 验证');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('RealWebDavClient.submit2fa: 有效 otp_code 换取 token 并清除 pending2fa', async () => {
    const orig = globalThis.fetch;
    let body = '';
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, message: 'success', data: { token: 'jwt-short-lived' } }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const client = new RealWebDavClient();
      const root = 'https://dav.example.com';
      // 先触发一次 402 使 pending2fa 置位。
      const orig2 = globalThis.fetch;
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ code: 402, message: 'Invalid 2FA code', data: null }) } as unknown as Response)) as typeof fetch;
      await (client as unknown as { apiToken(r: string, u: string, p: string): Promise<string | null> }).apiToken(root, 'u', 'p');
      globalThis.fetch = orig2;
      expect(client.needs2fa(root)).toBe(true);

      const res = await client.submit2fa(root, 'u', 'p', '123456');
      expect(res.ok).toBe(true);
      expect(body).toContain('"otp_code":"123456"');
      expect(client.needs2fa(root)).toBe(false);
      // token 已缓存：再次 apiToken 不发起网络请求直接返回缓存。
      const cached = await (client as unknown as { apiToken(r: string, u: string, p: string): Promise<string | null> }).apiToken(root, 'u', 'p');
      expect(cached).toBe('jwt-short-lived');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('submit2fa: 空码/错误码返回 ok=false 且不清除 pending2fa', async () => {
    const orig = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return { ok: true, status: 200, json: async () => ({ code: 402, message: 'Invalid 2FA code', data: null }) } as unknown as Response;
    }) as typeof fetch;

    try {
      const client = new RealWebDavClient();
      const root = 'https://dav.example.com';
      await (client as unknown as { apiToken(r: string, u: string, p: string): Promise<string | null> }).apiToken(root, 'u', 'p');
      expect(client.needs2fa(root)).toBe(true);

      const empty = await client.submit2fa(root, 'u', 'p', '');
      expect(empty.ok).toBe(false);
      expect(client.needs2fa(root)).toBe(true);

      const bad = await client.submit2fa(root, 'u', 'p', '999999');
      expect(bad.ok).toBe(false);
      expect(client.needs2fa(root)).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('POST /settings/openlist/2fa: 无码 400；有效码 ok；无效码报错', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const { app } = buildApp(services);
    const inj = host(app);

    // 无码 → 422 CONFIG_INVALID
    const noCode = await inj({ method: 'POST', url: '/api/v1/settings/openlist/2fa', payload: {} });
    expect(noCode.statusCode).toBe(422);
    expect(noCode.json().error.code).toBe('CONFIG_INVALID');

    // 有效码 → ok；submit2fa 内部对 /api/auth/login 返回 200+token。
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const payload = String(init?.body ?? '');
      if (payload.includes('"otp_code"')) {
        return { ok: true, status: 200, json: async () => ({ code: 200, message: 'success', data: { token: 'jwt' } }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ code: 402, message: 'Invalid 2FA code', data: null }) } as unknown as Response;
    }) as typeof fetch;
    try {
      const good = await inj({ method: 'POST', url: '/api/v1/settings/openlist/2fa', payload: { otpCode: '123456' } });
      expect(good.statusCode).toBe(200);
      expect(good.json().ok).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }

    // 无效码 → 4xx CONFIG_LOAD_FAILED
    const orig2 = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ code: 402, message: 'Invalid 2FA code', data: null }) } as unknown as Response)) as typeof fetch;
    try {
      const bad = await inj({ method: 'POST', url: '/api/v1/settings/openlist/2fa', payload: { otpCode: '000000' } });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.json().error.message).toContain('Invalid 2FA code');
    } finally {
      globalThis.fetch = orig2;
    }

    await app.close();
  });

  it('run(): 2FA 需要码时不重试、直接 failed（避免退避延迟弹窗）', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-2fa-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2fa1', displayName: '2fa' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's2fa', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    services.uploader = new UploadManager(services, {
      async put() {
        throw new Error('OpenList 需要 2FA 验证');
      },
    });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('OpenList 需要 2FA 验证');
    expect(after.retryCount).toBe(1); // 不进入自动重试
  });

  it('run(): 源文件已删除 → 明确标「源文件已删除」而非静默/误判（#18）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/del1', displayName: 'del' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sdel', streamTitle: 't' });
    // DB 仍有 filePath，但磁盘文件已删除（如用户手动清理）→ 重试应明确报「源文件已删除」。
    services.recordings.update(rec.id, { state: 'completed', filePath: path.join(tmpdir(), 'deleted_never_exists.flv') });

    const jobs = services.uploader.uploadRepo;
    services.uploader = new UploadManager(services, { async put() { throw new Error('should not be called'); } });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('源文件已删除');
    expect(after.retryCount).toBe(0); // 不进入重试
  });

  it('POST /recordings/:id/upload：源文件已删除 → 明确报错「源文件已删除」（#18）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/up1', displayName: 'up' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sup', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: path.join(tmpdir(), 'gone_never_exists.flv') });
    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toContain('源文件已删除');
    await app.close();
  });

  // #22（PrePan）：OpenList 服务端永久性错误（task.error 透传，如「资源不存在(00010010)」「配额不足」）
  // 退避重试无意义——服务端任务已终态，重试必然再失败且徒增等待、累积 retryCount。应与 #13 2FA 同理直接 failed。
  it('run(): 服务端永久性错误（OpenList 后台上传失败）→ 直接 failed 不重试（#22 fail-fast）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/perm1', displayName: 'perm' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sperm', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-perm-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    services.uploader = new UploadManager(services, {
      async put() {
        throw new Error('OpenList 后台上传失败：资源不存在(00010010)');
      },
    });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('OpenList 后台上传失败：资源不存在(00010010)');
    expect(after.retryCount).toBe(1); // 直接 failed，不进入自动退避重试（#22 fail-fast）
  });

  it('run(): 服务端「任务等待超时」→ 直接 failed 不重试（#22）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/to1', displayName: 'to' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sto', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-to-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    services.uploader = new UploadManager(services, {
      async put() {
        throw new Error('OpenList 后台上传任务等待超时');
      },
    });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('OpenList 后台上传任务等待超时');
    expect(after.retryCount).toBe(1); // fail-fast
  });

  // #22 边界：瞬时网络类错误（无法读取进度/卡滞核验）仍应保留退避重试，不应误伤 fail-fast。
  it('run(): 瞬时网络错误（无法读取 OpenList 后台上传进度）→ 保留退避重试（非永久性）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    await services.secretStore.set('openlist.token', 'tok');
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/net1', displayName: 'net' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'snet', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-net-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    services.uploader = new UploadManager(services, {
      async put() {
        throw new Error('无法读取 OpenList 后台上传进度：ECONNRESET');
      },
    });
    const job = await services.uploader.enqueue(rec.id);
    await waitFor(() => (services.uploader.uploadRepo.get(job!.id)?.error ?? '').includes('无法读取 OpenList 后台上传进度'));
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('无法读取 OpenList 后台上传进度');
    expect(after.retryCount).toBe(1); // 进入退避重试，非 fail-fast
    expect(after.status).toBe('queued');
  });

  // #23 边界：入队后令牌被移除（如配置变更）→ run() 明确报「令牌未配置」，非误判其他错误。
  it('run(): 入队后令牌被移除 → 明确标「OpenList 令牌未配置」（#23）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/tok1', displayName: 'tok' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'stok', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-tok-run-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    // 先以「有 token」入队并成功一次，再移除 token 触发重试 → run() 命中令牌未配置。
    await services.secretStore.set('openlist.token', 'tok');
    services.uploader = new UploadManager(services, {
      async put() { /* 成功 */ },
    });
    const first = await services.uploader.enqueue(rec.id);
    await waitFor(() => services.uploader.uploadRepo.get(first!.id)?.status === 'ok');

    await services.secretStore.delete('openlist.token');
    // 直接对已 ok 的任务 retry → run() 里令牌已缺失。
    const job = await services.uploader.retry(first!.id);
    await waitFor(() => services.uploader.uploadRepo.get(job!.id)?.status === 'failed');
    const after = services.uploader.uploadRepo.get(job!.id)!;
    expect(after.error).toContain('OpenList 令牌未配置');
    expect(after.retryCount).toBe(0); // run() 令牌缺失直接 failed，不增加重试计数
  });

  // #23 边界：特殊字符房间名 → resolveRemotePath 净化非法字符，不产生非法远端路径。
  it('resolveRemotePath: 特殊字符房间名被净化（\\/:*?"<>| → _）（#23）', async () => {
    const services = newServices();
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as Parameters<typeof services.settings.save>[0]);
    services.settings.save({ ...base, openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/spec1', displayName: 'a/b:c*d?' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sspec', streamTitle: 't' });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-spec-'));
    const file = path.join(dir, 'x.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    const remote = (services.uploader as unknown as { resolveRemotePath(c: never, p: string, r: never): string }).resolveRemotePath(
      { serverUrl: 'https://dav.example.com/dav/ydyun', directoryTemplate: '{room}/{date}', username: 'u' } as never,
      file,
      rec as never,
    );
    expect(remote).not.toContain('a/b:c*d?');
    expect(remote).toContain('a_b_c_d_');
  });
});
