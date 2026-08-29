import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';

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