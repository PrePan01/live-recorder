import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { AppError } from '../../src/types/error.js';
import { validatePipelineConfig } from '../../src/api/routes/settings.js';
import { livePrediction } from '../../src/api/routes/notifications.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any; body: string }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120', ...(o.headers ?? {}) } });
}

describe('V5 Phase 0 contract: tags', () => {
  it('tags CRUD + room tags round-trip and dedupe', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    // 房间
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: '主播1' } })).json().room;
    expect(room.tags).toEqual([]);

    // 标签 CRUD
    const t1 = (await inj({ method: 'POST', url: '/api/v1/tags', payload: { name: 'B站', color: '#ff0000' } })).json().tag;
    const t2 = (await inj({ method: 'POST', url: '/api/v1/tags', payload: { name: '音乐', color: '#00ff00' } })).json().tag;
    expect(t1.id.startsWith('tag_')).toBe(true);
    const dup = await inj({ method: 'POST', url: '/api/v1/tags', payload: { name: 'B站' } });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.code).toBe('TAG_INVALID');

    // 列表
    const list = (await inj({ method: 'GET', url: '/api/v1/tags' })).json().tags;
    expect(list).toHaveLength(2);

    // 改名 + 非法颜色
    const renamed = (await inj({ method: 'PATCH', url: `/api/v1/tags/${t1.id}`, payload: { name: 'B站直播', color: '#abcdef' } })).json().tag;
    expect(renamed.name).toBe('B站直播');
    const badColor = await inj({ method: 'PATCH', url: `/api/v1/tags/${t1.id}`, payload: { color: 'red' } });
    expect(badColor.statusCode).toBe(422);

    // 覆盖式设置房间标签（去重 + 上限）
    const setTags = await inj({ method: 'PUT', url: `/api/v1/rooms/${room.id}/tags`, payload: { tagIds: [t1.id, t2.id, t1.id] } });
    expect(setTags.json().room.tags).toHaveLength(2);
    const roomAfter = (await inj({ method: 'GET', url: '/api/v1/rooms' })).json().rooms.find((r: { id: string }) => r.id === room.id);
    expect(roomAfter.tags.map((t: { name: string }) => t.name).sort()).toEqual(['B站直播', '音乐']);

    // 不存在标签 → 404
    const missing = await inj({ method: 'PUT', url: `/api/v1/rooms/${room.id}/tags`, payload: { tagIds: ['tag_none'] } });
    expect(missing.statusCode).toBe(404);

    // 删除标签后房间关联消失
    await inj({ method: 'DELETE', url: `/api/v1/tags/${t1.id}` });
    const afterDelete = (await inj({ method: 'GET', url: '/api/v1/rooms' })).json().rooms.find((r: { id: string }) => r.id === room.id);
    expect(afterDelete.tags).toHaveLength(1);
    await app.close();
  });

  it('PATCH /rooms/:id accepts uploadEnabled override (null=inherit)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'u' } })).json().room;
    expect(room.uploadEnabled).toBeNull();
    const set = (await inj({ method: 'PATCH', url: `/api/v1/rooms/${room.id}`, payload: { uploadEnabled: false } })).json().room;
    expect(set.uploadEnabled).toBe(false);
    const bad = await inj({ method: 'PATCH', url: `/api/v1/rooms/${room.id}`, payload: { uploadEnabled: 'yes' } });
    expect(bad.statusCode).toBe(422);
    await app.close();
  });
});

describe('V5 Phase 0 contract: search', () => {
  it('searches rooms/recordings/alerts with pagination and filters', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: '测试主播' } })).json().room;

    // 空查询 → 422
    const empty = await inj({ method: 'GET', url: '/api/v1/search?q=' });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('SEARCH_QUERY_INVALID');

    // 房间命中
    const hit = (await inj({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('测试')}` })).json();
    expect(hit.total).toBeGreaterThanOrEqual(1);
    expect(hit.items.some((i: { type: string; id: string }) => i.type === 'room' && i.id === room.id)).toBe(true);

    // type=alert 无命中 → 200 空集
    const alerts = (await inj({ method: 'GET', url: `/api/v1/search?q=测试&type=alert` })).json();
    expect(alerts.total).toBe(0);
    expect(alerts.items).toEqual([]);

    // 非法 type → 422
    const badType = await inj({ method: 'GET', url: '/api/v1/search?q=x&type=bogus' });
    expect(badType.statusCode).toBe(422);
    await app.close();
  });
});

describe('V5 Phase 0 contract: stats aggregation', () => {
  it('aggregates recordings server-side with short cache', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 's' } })).json().room;
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', endedAt: '2026-08-27T10:00:00.000Z', fileSizeBytes: 1024 });
    services.db.prepare('UPDATE recordings SET started_at = ? WHERE id = ?').run('2026-08-27T09:00:00.000Z', rec.id);

    const res = await inj({ method: 'GET', url: '/api/v1/stats/recordings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.recordings).toBe(1);
    expect(body.totals.completed).toBe(1);
    expect(body.totals.successRate).toBe(100);
    expect(body.byDay.length).toBeGreaterThanOrEqual(1);
    expect(body.byPlatform.find((p: { platform: string }) => p.platform === 'bilibili').recordings).toBe(1);
    expect(body.generatedAt).toBeTruthy();

    // 短缓存：第二次同参数命中缓存，generatedAt 不变
    const again = (await inj({ method: 'GET', url: '/api/v1/stats/recordings' })).json();
    expect(again.generatedAt).toBe(body.generatedAt);

    // 非法时间范围 → 错误信封
    const bad = await inj({ method: 'GET', url: '/api/v1/stats/recordings?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z' });
    expect(bad.statusCode).toBe(500);
    await app.close();
  });
});

describe('V5 Phase 0 contract: diagnostics', () => {
  it('creates, lists, and runs idempotent actions', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const d = services.diagnostics.create({
      code: 'RECORDING_START_FAILED',
      severity: 'error',
      suggestion: '重试录制',
    });
    expect(d.status).toBe('open');

    const list = (await inj({ method: 'GET', url: '/api/v1/diagnostics' })).json();
    expect(list.total).toBe(1);

    // 单条详情
    const detail = (await inj({ method: 'GET', url: `/api/v1/diagnostics/${d.id}` })).json();
    expect(detail.diagnostic.id).toBe(d.id);

    // 执行动作 → resolved
    const act = await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/retry`, payload: { idempotencyKey: 'k1' } });
    expect(act.statusCode).toBe(200);
    expect(act.json().diagnostic.status).toBe('resolved');
    expect(act.json().action.result).toBe('ok');

    // 同 key 幂等：返回同一动作，不重复执行
    const again = await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/retry`, payload: { idempotencyKey: 'k1' } });
    expect(again.json().action.idempotencyKey).toBe('k1');
    expect(again.json().action.id).toBe(act.json().action.id);

    // 缺 idempotencyKey → 422
    const noKey = await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/retry`, payload: {} });
    expect(noKey.statusCode).toBe(422);

    // 不支持的动作 → 422
    const badAction = await inj({ method: 'POST', url: `/api/v1/diagnostics/${d.id}/actions/nuke`, payload: { idempotencyKey: 'k2' } });
    expect(badAction.statusCode).toBe(422);
    expect(badAction.json().error.code).toBe('DIAGNOSTIC_ACTION_INVALID');

    // 不存在 → 404
    const missing = await inj({ method: 'GET', url: '/api/v1/diagnostics/diag_none' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('reuses active diagnostic for same recordingId+code (single-flight)', () => {
    const services = newServices();
    const first = services.diagnostics.create({ recordingId: 'rec_x', code: 'RECORDING_START_FAILED', severity: 'error', suggestion: 's' });
    const second = services.diagnostics.create({ recordingId: 'rec_x', code: 'RECORDING_START_FAILED', severity: 'error', suggestion: 's' });
    expect(second.id).toBe(first.id);
    const other = services.diagnostics.create({ recordingId: 'rec_y', code: 'RECORDING_START_FAILED', severity: 'error', suggestion: 's' });
    expect(other.id).not.toBe(first.id);
  });
});

describe('V5 Phase 0 contract: pipeline config', () => {
  it('reads defaults and validates partial updates', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const def = (await inj({ method: 'GET', url: '/api/v1/settings/pipeline' })).json();
    expect(def.pipeline.enabled).toBe(false);
    expect(def.pipeline.maxConcurrency).toBe(2);
    expect(def.pipeline.verify).toBe(true);

    const set = (await inj({ method: 'PUT', url: '/api/v1/settings/pipeline', payload: { enabled: true, segmentSeconds: 60 } })).json();
    expect(set.pipeline.enabled).toBe(true);
    expect(set.pipeline.segmentSeconds).toBe(60);
    expect(set.pipeline.crf).toBeNull();

    const bad = await inj({ method: 'PUT', url: '/api/v1/settings/pipeline', payload: { maxConcurrency: 5 } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('PIPELINE_CONFIG_INVALID');

    // settings 视图包含 pipeline
    const view = (await inj({ method: 'GET', url: '/api/v1/settings' })).json().settings;
    expect(view.pipeline.enabled).toBe(true);

    // theme 偏好随 settings 读写（缺省 system）
    expect(view.theme).toBe('system');
    const themed = await inj({ method: 'PUT', url: '/api/v1/settings', payload: { recordingDirectory: '/tmp/vids', theme: 'dark' } });
    expect(themed.statusCode).toBe(200);
    expect(themed.json().settings.theme).toBe('dark');
    const badTheme = await inj({ method: 'PUT', url: '/api/v1/settings', payload: { recordingDirectory: '/tmp/vids', theme: 'neon' } });
    expect(badTheme.statusCode).toBe(500);
    await app.close();
  });

  it('validates pipeline config directly', () => {
    expect(validatePipelineConfig({ enabled: false, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2 })).toBeNull();
    expect(validatePipelineConfig({ enabled: true, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 3 })?.code).toBe('PIPELINE_CONFIG_INVALID');
  });
});

describe('V5 Phase 0: recording processing state + pipeline fields', () => {
  it('persists processing state, pipelineStatus, metadata and coverPath', () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/5', displayName: 'p' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'p1', streamTitle: 't' });
    services.recordings.update(rec.id, {
      state: 'processing',
      pipelineStatus: 'running',
      metadata: { durationMs: 9000, segmentCount: 2, quality: '1080p', size: 2048 },
      coverPath: '/tmp/cover.jpg',
    });
    const loaded = services.recordings.get(rec.id)!;
    expect(loaded.state).toBe('processing');
    expect(loaded.pipelineStatus).toBe('running');
    expect(loaded.metadata?.durationMs).toBe(9000);
    expect(loaded.metadata?.segmentCount).toBe(2);
    expect(loaded.coverPath).toBe('/tmp/cover.jpg');
  });
});
describe('V5 notifications + live prediction contract', () => {
  it('reads defaults and persists notification preferences', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);

    const def = (await inj({ method: 'GET', url: '/api/v1/settings/notifications' })).json();
    expect(def.notifications.desktopEnabled).toBe(true);
    expect(def.notifications.dedupeWindowMinutes).toBe(30);

    const set = await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { desktopEnabled: false, liveStarted: true, dedupeWindowMinutes: 60 } });
    expect(set.statusCode).toBe(200);
    expect(set.json().notifications.desktopEnabled).toBe(false);
    expect(set.json().notifications.dedupeWindowMinutes).toBe(60);

    const bad = await inj({ method: 'PUT', url: '/api/v1/settings/notifications', payload: { dedupeWindowMinutes: 9999 } });
    expect(bad.statusCode).toBe(500);
    await app.close();
  });

  it('test notification returns desktop flag and skipped email when SMTP unconfigured', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'POST', url: '/api/v1/notifications/test' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().email).toBe('skipped');
    await app.close();
  });

  it('live prediction returns null with insufficient samples and window with enough', () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/6', displayName: 'pred' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'pd1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed', endedAt: '2026-08-27T11:00:00.000Z' });
    services.db.prepare('UPDATE recordings SET started_at = ? WHERE id = ?').run('2026-08-27T09:00:00.000Z', rec.id);
    // 仅 1 天样本 → null + notice
    const single = livePrediction(services, room.id);
    expect(single.startAt).toBeNull();
    expect(single.confidence).toBeNull();
    expect(single.notice).toContain('样本不足');
    expect(single.basedOnDays).toBe(1);

    // 补足 3 天 → 给出窗口（低置信）
    for (const [day, start, end] of [
      ['2026-08-25', '09:00:00.000Z', '11:00:00.000Z'],
      ['2026-08-26', '09:30:00.000Z', '11:30:00.000Z'],
    ] as const) {
      const r = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: `pd_${day}`, streamTitle: 't' });
      services.recordings.update(r.id, { state: 'completed', endedAt: `${day}T${end}` });
      services.db.prepare('UPDATE recordings SET started_at = ? WHERE id = ?').run(`${day}T${start}`, r.id);
    }
    const win = livePrediction(services, room.id);
    expect(win.basedOnDays).toBe(3);
    expect(win.confidence).toBe('low');
    expect(win.startAt).toMatch(/^\d{2}:\d{2}$/);
    expect(win.endAt).toMatch(/^\d{2}:\d{2}$/);
    expect(win.notice).toBeNull();
  });

  it('live prediction endpoint 404s for unknown room', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'GET', url: '/api/v1/rooms/room_none/live-prediction' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
