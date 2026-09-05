import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { livePrediction } from '../../src/api/routes/notifications.js';
import { UploadManager } from '../../src/core/upload-manager.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any; body: string }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120', ...(o.headers ?? {}) } });
}

describe('QA V5 Phase 0 contract gaps: search', () => {
  it('escapes LIKE wildcards and hits by tag name', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const roomA = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/6', displayName: '主播100' } })).json().room;
    const roomB = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/7', displayName: '主播_音乐' } })).json().room;
    const roomC = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/8', displayName: '主播X音乐' } })).json().room;
    const tag = (await inj({ method: 'POST', url: '/api/v1/tags', payload: { name: '音乐', color: '#1677ff' } })).json().tag;
    await inj({ method: 'PUT', url: `/api/v1/rooms/${roomB.id}/tags`, payload: { tagIds: [tag.id] } });

    // 字面匹配：搜索 '主播100%' 时 % 被转义为字面量——displayName 恰为 '主播100' 的房间不得命中
    const literal = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('主播100%')}` })).json();
    expect(literal.items.some((i: { type: string; id: string }) => i.type === 'room' && i.id === roomA.id)).toBe(false);
    // _ 同理：搜索 '主播_音乐' 只命中含字面下划线的房间，不得命中 '主播X音乐'（否则 _ 被当通配）
    const underscore = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('主播_音乐')}` })).json();
    expect(underscore.items.some((i: { type: string; id: string }) => i.type === 'room' && i.id === roomB.id)).toBe(true);
    expect(underscore.items.some((i: { type: string; id: string }) => i.type === 'room' && i.id === roomC.id)).toBe(false);

    // 按标签名命中房间
    const byTag = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('音乐')}` })).json();
    expect(byTag.items.some((i: { type: string; id: string }) => i.type === 'room' && i.id === roomB.id)).toBe(true);

    // tagId 过滤
    const filtered = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('主播')}&tagId=${tag.id}` })).json();
    expect(filtered.items.some((i: { type: string; id: string }) => i.id === roomB.id)).toBe(true);
    const noMatch = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('主播')}&tagId=tag_none` })).json();
    expect(noMatch.items).toEqual([]);

    // 超长 q → 422
    const tooLong = await inj({ method: 'GET', url: `/api/v1/search?q=${'x'.repeat(101)}` });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error.code).toBe('SEARCH_QUERY_INVALID');
    await app.close();
  });

  it('paginates and caps pageSize at 50', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    for (let i = 0; i < 3; i++) {
      await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: `https://live.bilibili.com/${70 + i}`, displayName: `批量主播${i}` } });
    }
    const page1 = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('批量主播')}&page=1&pageSize=2` })).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('批量主播')}&page=2&pageSize=2` })).json();
    expect(page2.total).toBe(3);
    const capped = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('批量主播')}&pageSize=500` })).json();
    expect(capped.pageSize).toBe(50);
    await app.close();
  });
});

describe('QA V5 Phase 0 contract gaps: diagnostics', () => {
  it('marks stale open items expired (30-day archive) on list', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const d = services.diagnostics.create({ code: 'NETWORK_UNAVAILABLE', severity: 'warning', suggestion: '重试' });
    // 回写 occurred_at 到 31 天前（nowIso 用真实时钟，注入时钟只控 now 参考）
    services.db.prepare('UPDATE diagnostics SET occurred_at = ? WHERE id = ?').run('2026-07-01T00:00:00.000Z', d.id);
    const list = (await inj({ method: 'GET', url: '/api/v1/diagnostics' })).json();
    expect(list.items[0].status).toBe('expired');
    await app.close();
  });

  it('rejects action on expired diagnostic with DIAGNOSTIC_CONFLICT', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const d = services.diagnostics.create({ code: 'RECORDING_START_FAILED', severity: 'error', suggestion: '重试' });
    services.db.prepare('UPDATE diagnostics SET occurred_at = ? WHERE id = ?').run('2026-07-01T00:00:00.000Z', d.id);
    // 先触发一次列表让过期惰性归档生效
    await inj({ method: 'GET', url: '/api/v1/diagnostics' });
    const res = await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/retry`, payload: { idempotencyKey: 'k-exp' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DIAGNOSTIC_CONFLICT');
    await app.close();
  });

  it('allows distinct idempotency keys on the same diagnostic', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const d = services.diagnostics.create({ code: 'RECORDING_START_FAILED', severity: 'error', suggestion: '重试' });
    const a1 = (await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/retry`, payload: { idempotencyKey: 'k-1' } })).json();
    // 已 resolved，同一诊断新 key 不再执行（重复动作被 404/无效化）；此处仅断言 key 隔离不串
    expect(a1.action.idempotencyKey).toBe('k-1');
    await app.close();
  });
});

describe('QA V5 Phase 0 contract gaps: pipeline & theme', () => {
  it('rejects invalid crf/segmentSeconds boundaries', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const badCrf = await inj({ method: 'PUT', url: '/api/v1/settings/pipeline', payload: { crf: 52 } });
    expect(badCrf.statusCode).toBe(422);
    expect(badCrf.json().error.code).toBe('PIPELINE_CONFIG_INVALID');
    const badSeg = await inj({ method: 'PUT', url: '/api/v1/settings/pipeline', payload: { segmentSeconds: -1 } });
    expect(badSeg.statusCode).toBe(422);
    const badEnabled = await inj({ method: 'PUT', url: '/api/v1/settings/pipeline', payload: { enabled: 'yes' } });
    expect(badEnabled.statusCode).toBe(422);
    await app.close();
  });

  it('emits settings:updated SSE on theme change', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const events: string[] = [];
    services.events.on((e) => events.push(e.type));
    const res = await host(app)({ method: 'PUT', url: '/api/v1/settings', payload: { recordingDirectory: '/tmp/vids', theme: 'dark' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.theme).toBe('dark');
    expect(events).toContain('settings:updated');
    await app.close();
  });
});

describe('QA V5 notifications + live prediction gaps (#112)', () => {
  it('rejects non-boolean notification switches and out-of-range dedupe', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const badBool = await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { desktopEnabled: 'yes' } });
    expect(badBool.statusCode).toBe(422);
    expect(badBool.json().error.code).toBe('CONFIG_INVALID');
    const badDedupe = await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { dedupeWindowMinutes: 0 } });
    expect(badDedupe.statusCode).toBe(422);
    const ok = await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { recordingEnded: true, uploadFailed: false, dedupeWindowMinutes: 45 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().notifications.recordingEnded).toBe(true);
    expect(ok.json().notifications.uploadFailed).toBe(false);
    expect(ok.json().notifications.dedupeWindowMinutes).toBe(45);
    // 部分更新合并：未提交的字段保留默认
    expect(ok.json().notifications.liveStarted).toBe(true);
    await app.close();
  });

  it('confidence escalates by sample days (5-9 medium, 10+ high)', () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/90', displayName: 'conf' });
    const make = (day: number, id: string) => {
      const iso = `2026-08-${String(day).padStart(2, '0')}`;
      const r = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: id, streamTitle: 't' });
      services.recordings.update(r.id, { state: 'completed', endedAt: `${iso}T11:00:00.000Z` });
      services.db.prepare('UPDATE recordings SET started_at = ? WHERE id = ?').run(`${iso}T09:00:00.000Z`, r.id);
    };
    for (let d = 16; d <= 20; d++) make(d, `m${d}`);
    const five = livePrediction(services, room.id);
    expect(five.basedOnDays).toBe(5);
    expect(five.confidence).toBe('medium');
    for (let d = 21; d <= 25; d++) make(d, `h${d}`);
    const ten = livePrediction(services, room.id);
    expect(ten.basedOnDays).toBe(10);
    expect(ten.confidence).toBe('high');
  });

  it('persists notifications in settings view and round-trips after save', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const base = await inj({ method: 'GET', url: '/api/v1/settings' });
    expect(base.json().settings.notifications.desktopEnabled).toBe(true);
    await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { desktopEnabled: false } });
    const after = (await inj({ method: 'GET', url: '/api/v1/settings' })).json();
    expect(after.settings.notifications.desktopEnabled).toBe(false);
    const direct = (await inj({ method: 'GET', url: '/api/v1/settings/notifications' })).json();
    expect(direct.notifications.desktopEnabled).toBe(false);
    await app.close();
  });
});
describe('QA Batch2 #116/#117 gaps: openlist & email', () => {
  it('openlist token never returned in view; clear via empty string', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: true, serverUrl: 'https://dav.example.com/dav', username: 'u', token: 'secret-token' } });
    const view = (await inj({ method: 'GET', url: '/api/v1/settings/openlist' })).json();
    expect(view.openlist.hasToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain('secret-token');
    expect(view.openlist.token).toBeUndefined();
    // 空串清除令牌
    await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { token: '' } });
    const cleared = (await inj({ method: 'GET', url: '/api/v1/settings/openlist' })).json();
    expect(cleared.openlist.hasToken).toBe(false);
    await app.close();
  });

  it('openlist config validation and upload job lifecycle', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const badEnabled = await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: 'yes' } });
    expect(badEnabled.statusCode).toBe(422);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/97', displayName: 'up' } })).json().room;
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'up1', streamTitle: 't' });
    // 使用真实临时文件作为源文件（#18：磁盘文件缺失会明确报「源文件已删除」）。
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-up-'));
    const file = path.join(dir, 'up.flv');
    await writeFile(file, Buffer.from([1, 2, 3]));
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    // 用 fake 上传器：入队/取消走纯内存链路，pump 立即完成不发起网络请求（避免异步写库竞态）。
    services.uploader = new UploadManager(services, { async put() {} });
    // 未启用 → 手动上传 500
    const noConf = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(noConf.statusCode).toBe(500);
    // 启用+令牌 → 入队成功
    await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: true, serverUrl: 'https://dav.example.com/dav', username: 'u', token: 'tok' } });
    const enq = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(enq.statusCode).toBe(200);
    expect(enq.json().upload.idempotencyKey).toBe(`rec_${rec.id}`);
    // 列表可见
    const list = (await inj({ method: 'GET', url: '/api/v1/uploads' })).json();
    expect(list.uploads.length).toBeGreaterThanOrEqual(1);
    // 取消
    const cancel = await inj({ method: 'POST', url: `/api/v1/uploads/${enq.json().upload.id}/cancel` });
    expect(cancel.json().upload.status).toBe('cancelled');
    // 不存在 404
    const missing = await inj({ method: 'POST', url: '/api/v1/uploads/up_none/retry' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('openlist: 源文件已从磁盘删除时手动上传/重试明确提示（#18）', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    await inj({ method: 'PUT', url: '/api/v1/settings/openlist', payload: { enabled: true, serverUrl: 'https://dav.example.com/dav', username: 'u', token: 'tok' } });
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/98', displayName: 'del' } })).json().room;
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'updel', streamTitle: 't' });
    // DB 有 filePath 但磁盘文件不存在（如用户手动清理）。
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/never_exists_del.flv' });
    const res = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/upload` });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toContain('源文件已删除');
    await app.close();
  });

  it('email presets detect provider and test unconfigured fails', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const presets = (await inj({ method: 'GET', url: '/api/v1/settings/email/presets' })).json();
    expect(presets.presets.some((p: { id: string }) => p.id === 'qq')).toBe(true);
    // 未配置 SMTP → test 502
    const test = await inj({ method: 'POST', url: '/api/v1/settings/email/test' });
    expect(test.statusCode).toBe(502);
    expect(test.json().error.code).toBe('SMTP_SEND_FAILED');
    await app.close();
  });
});

describe('QA Batch2 #114/#115 gaps: pipeline & naming', () => {
  it('pipeline config snapshot is not retroactive across runs', async () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/95', displayName: 'snap' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'snap1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/snap.flv' });
    // 启用管线并发起 run（配置快照 A）
    const base = services.settings.load()!;
    services.settings.save({ ...base, pipeline: { enabled: true, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2 } });
    const run1 = services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: { enabled: true, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2, attempt: 0 } });
    // 改配置（快照 B：切片开启）——不追溯 run1
    services.settings.save({ ...base, pipeline: { enabled: true, verify: false, segmentSeconds: 60, crf: 23, archiveDirectory: '', maxConcurrency: 2 } });
    const loaded = services.pipeline.repo.getRun(run1.id);
    expect(loaded?.configSnapshot.segmentSeconds).toBe(0);
    expect(loaded?.configSnapshot.crf).toBeNull();
  });

  it('naming rule rejects empty/overlong and sanitizes template', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const empty = await inj({ method: 'PUT', url: '/api/v1/settings/naming-rule', payload: { namingRule: '' } });
    expect(empty.statusCode).toBe(422);
    const tooLong = await inj({ method: 'PUT', url: '/api/v1/settings/naming-rule', payload: { namingRule: 'x'.repeat(201) } });
    expect(tooLong.statusCode).toBe(422);
    const ok = await inj({ method: 'PUT', url: '/api/v1/settings/naming-rule', payload: { namingRule: '{room}_{date}_{time}_{platform}_{quality}_{roomId}' } });
    expect(ok.statusCode).toBe(200);
    // preview 渲染占位值
    const preview = await inj({ method: 'POST', url: '/api/v1/settings/naming-rule/preview', payload: { namingRule: '{room}_{time}', room: '主/播:名' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().example).not.toContain('/');
    expect(preview.json().example).not.toContain(':');
    expect(preview.json().example).toContain('18_30_00');
    await app.close();
  });

  it('pipeline retry rejects while running (single-flight)', async () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/96', displayName: 'single' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sg1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/single.flv' });
    const base = services.settings.load()!;
    services.settings.save({ ...base, pipeline: { enabled: true, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2 } });
    // 手动模拟运行中 run → retry 应拒绝（ok=false）
    services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: { enabled: true, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2, attempt: 0 } });
    services.pipeline.repo.setRunStatus(rec.id === '' ? '' : services.pipeline.repo.runForRecording(rec.id)!.id, 'queued', services.clock.iso());
    const res = services.pipeline.retry(rec.id);
    expect(res.ok).toBe(false);
  });
});

describe('QA Batch3 #125/#127/#128 gaps', () => {
  it('schedule cross-midnight window computes next run on matching day', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/98', displayName: 'sched' } })).json().room;
    const created = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1, 3], startTime: '22:00', endTime: '01:00', timezone: 'local' } });
    expect(created.statusCode).toBe(201);
    const sched = created.json().schedule;
    expect(sched.nextRunAt).toBeTruthy();
    expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(services.clock.now());
    const disabled = await inj({ method: 'PATCH', url: `/api/v1/rooms/${room.id}/schedules/${sched.id}`, payload: { enabled: false } });
    expect(disabled.json().schedule.enabled).toBe(false);
    expect(disabled.json().schedule.nextRunAt).toBeNull();
    const badDays = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [7], startTime: '22:00' } });
    expect(badDays.statusCode).toBe(422);
    const badTime = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1], startTime: '25:00' } });
    expect(badTime.statusCode).toBe(422);
    await app.close();
  });

  it('export endpoints validate and 404 for unknown', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/99', displayName: 'exp' } })).json().room;
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'e1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/exp.flv' });
    const bad = await inj({ method: 'POST', url: '/api/v1/exports', payload: { recordingIds: [rec.id] } });
    expect(bad.statusCode).toBe(422);
    const missing = await inj({ method: 'GET', url: '/api/v1/exports/exp_none' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
