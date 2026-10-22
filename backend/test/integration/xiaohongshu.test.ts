import { saveXiaohongshuSource } from '../../src/platform/xiaohongshu-source-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { buildApp } from '../../src/api/server.js';
import { XIAOHONGSHU_COOKIE_KEY } from '../../src/security/keys.js';
import { XiaohongshuAdapter } from '../../src/platform/xiaohongshu.js';
import { FakeClock } from '../../src/core/clock.js';

const headers = { host: '127.0.0.1:43120' };
const profile = 'https://www.xiaohongshu.com/user/profile/abcdef';
const roomUrl = 'https://www.xiaohongshu.com/livestream/123?xsec_token=test';
const active: Array<{ services: Services; app: ReturnType<typeof buildApp>['app'] }> = [];
function setup() {
  const services = buildServices({ dbPath: ':memory:', mode: 'fake', clock: new FakeClock() });
  const { app } = buildApp(services); active.push({ services, app }); return { services, app };
}
afterEach(async () => { for (const { app } of active.splice(0)) await app.close(); });

describe('Xiaohongshu product integration', () => {
  it('clears the restricted state and warning after detecting an ended authenticated broadcast', async () => {
    const { services } = setup();
    const room = services.rooms.create({ platform: 'xiaohongshu', url: roomUrl, displayName: '主播' });
    await services.secretStore.set(XIAOHONGSHU_COOKIE_KEY, 'web_session=local');
    services.rooms.setLiveStatus(room.id, 'restricted');
    services.rooms.setState(room.id, 'failed', { lastError: {
      code: 'PLATFORM_ACCESS_RESTRICTED', message: '平台访问受限，请检查授权',
      roomId: room.id, recordingId: null, occurredAt: services.clock.iso(), retryable: true,
    } });
    services.alerts.createOrRefresh({
      level: 'warning', source: 'platform', message: '平台访问受限，请检查授权',
      occurredAt: services.clock.iso(), roomId: room.id, errorCode: 'PLATFORM_ACCESS_RESTRICTED', retryable: true,
    });
    const adapter = new XiaohongshuAdapter((async (raw: string) => new Response(raw.includes('/user/profile')
      ? '<script>window.__INITIAL_STATE__={"user":{}}</script>'
      : '<script>window.__INITIAL_STATE__={"liveStream":{"liveStatus":"end","roomData":{"roomInfo":{"roomId":"123","status":3}}}}</script>')) as typeof fetch, {
      load: () => roomUrl, save: () => {}, profileForRoom: () => profile,
    });
    const original = services.adapterFor.bind(services);
    services.adapterFor = platform => platform === 'xiaohongshu' ? adapter : original(platform);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
    expect(services.rooms.get(room.id)).toMatchObject({ lastLiveStatus: 'offline', monitorState: 'idle', lastError: null });
    expect(services.alerts.list({ unresolvedOnly: true }).filter(alert => alert.roomId === room.id)).toEqual([]);
  });

  it('adds, deduplicates and batch-imports all three platforms through the existing API', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers, payload: { url: profile, displayName: '小红书主播' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().room).toMatchObject({ platform: 'xiaohongshu', url: profile });
    const batch = await app.inject({ method: 'POST', url: '/api/v1/rooms/batch', headers, payload: { urls: [profile, 'https://live.bilibili.com/1', 'https://live.douyin.com/2'] } });
    expect(batch.json().succeeded.map((r: { platform: string }) => r.platform).sort()).toEqual(['bilibili', 'douyin']);
    expect(batch.json().failed).toHaveLength(1);
  });
  it('normalizes real room shares to one host through the API', async () => {
    const { app, services } = setup();
    const original = services.adapterFor.bind(services);
    const adapter = new XiaohongshuAdapter((async () => new Response('<script>window.__INITIAL_STATE__={"liveStream":{"liveStatus":"success","roomData":{"roomInfo":{"status":2,"roomId":"123","deeplink":"xhsdiscover://live_audience?host_id=abcdef"}}}}</script>')) as typeof fetch);
    services.adapterFor = platform => platform === 'xiaohongshu' ? adapter : original(platform);
    const first = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers, payload: { url: roomUrl, displayName: '主播' } });
    expect(first.statusCode).toBe(201);
    expect(first.json().room.url).toBe(roomUrl);
    expect(first.json().room.liveRoomUrl).toBe(roomUrl);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers });
    expect(listed.json().rooms[0]).toMatchObject({ url: roomUrl, liveRoomUrl: roomUrl });
    const second = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers, payload: { url: roomUrl + '&track_id=other', displayName: '主播' } });
    expect(second.statusCode).toBe(409);
  });
  it('persists live URLs, deduplicates later broadcasts by host and discovers new sessions only after ending', async () => {
    const { app, services } = setup();
    let broadcast = '123'; let ended = false;
    const visited: string[] = [];
    const original = services.adapterFor.bind(services);
    const adapter = new XiaohongshuAdapter((async (raw: string) => {
      visited.push(raw);
      if (raw.includes('/user/profile/')) return new Response(`<script>window.__INITIAL_STATE__={"user":{"liveLink":"https://www.xiaohongshu.com/livestream/${broadcast}?xsec_token=test"}}</script>`);
      const id = /livestream\/(\d+)/.exec(raw)![1];
      const offline = ended && id === '123';
      return new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify({ liveStream: { liveStatus: offline ? 'end' : 'success', roomData: { roomInfo: { roomId: id, status: offline ? 3 : 2, deeplink: 'xhsdiscover://live_audience?host_id=abcdef' } } } })}</script>`);
    }) as typeof fetch, {
      load: key => (services.db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url=?').get(key) as { room_url: string } | undefined)?.room_url,
      save: (key, url) => saveXiaohongshuSource(services.db, key, url),
      profileForRoom: url => (services.db.prepare('SELECT profile_url FROM xiaohongshu_sources WHERE room_url=?').get(url) as { profile_url: string } | undefined)?.profile_url,
    });
    services.adapterFor = platform => platform === 'xiaohongshu' ? adapter : original(platform);
    const added = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers, payload: { url: profile, displayName: '主播' } });
    expect(added.statusCode).toBe(201);
    const localId = added.json().room.id;
    expect(services.rooms.get(localId)?.url).toBe(roomUrl);
    visited.length = 0;
    expect(await adapter.checkLiveStatus(roomUrl)).toMatchObject({ status: 'live', streamSessionId: '123' });
    expect(visited).toEqual([roomUrl]);
    ended = true; broadcast = '456'; visited.length = 0;
    expect(await adapter.checkLiveStatus(roomUrl)).toMatchObject({ status: 'live', streamSessionId: '456' });
    expect(visited.filter(url => url.includes('/user/profile/'))).toHaveLength(1);
    const current = 'https://www.xiaohongshu.com/livestream/456?xsec_token=test';
    expect(services.rooms.get(localId)?.url).toBe(current);
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers, payload: { url: current, displayName: '主播' } });
    expect(duplicate.statusCode).toBe(409);
    expect(services.rooms.list()).toHaveLength(1);
    // Old recording recovery must finish rather than switch to the next broadcast.
    expect(await adapter.resolveRecordingSource(current, 'original', undefined, { streamSessionId: '123' })).toMatchObject({ status: 'offline' });
    expect(services.rooms.get(localId)?.url).toBe(current);
    // An old preview finishing late must not roll the persisted broadcast back.
    await adapter.resolveRoom(roomUrl, undefined, undefined, undefined, { media: true });
    expect(services.rooms.get(localId)?.url).toBe(current);
  });
  it.each([
    { cookie: null, status: 'warn', detail: '小红书未授权' },
    { cookie: 'web_session=self-check-private-session; a1=device', status: 'ok', detail: '授权凭据已配置' },
    { cookie: 'a1=self-check-invalid-cookie', status: 'warn', detail: '授权凭据格式无效' },
  ])('includes local Xiaohongshu authorization in self-check ($status, $detail)', async ({ cookie, status, detail }) => {
    const { app, services } = setup();
    if (cookie) await services.secretStore.set(XIAOHONGSHU_COOKIE_KEY, cookie);
    const result = await app.inject({ method: 'GET', url: '/api/v1/service/self-check', headers });
    expect(result.statusCode).toBe(200);
    const items = result.json().items;
    expect(items.find((item: { key: string }) => item.key === 'xiaohongshu-cookie')).toMatchObject({ label: '小红书授权', status, detail: expect.stringContaining(detail) });
    expect(items.map((item: { key: string }) => item.key)).toEqual(expect.arrayContaining(['cookie', 'bilibili-cookie', 'xiaohongshu-cookie', 'disk', 'ffmpeg']));
    expect(result.body).not.toMatch(/self-check-private-session|self-check-invalid-cookie|web_session|a1=/);
  });
  it('isolates a Xiaohongshu credential read failure without exposing its error or breaking other checks', async () => {
    const { app, services } = setup();
    const original = services.secretStore.get.bind(services.secretStore);
    const spy = vi.spyOn(services.secretStore, 'get').mockImplementation(async key => {
      if (key === XIAOHONGSHU_COOKIE_KEY) throw new Error('private-keychain-error');
      return original(key);
    });
    try {
      const result = await app.inject({ method: 'GET', url: '/api/v1/service/self-check', headers });
      expect(result.statusCode).toBe(200);
      expect(result.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'xiaohongshu-cookie', label: '小红书授权', status: 'warn', detail: '无法读取小红书授权凭据' }),
        expect.objectContaining({ key: 'backend', status: 'ok' }),
        expect.objectContaining({ key: 'bilibili-cookie' }),
      ]));
      expect(result.body).not.toContain('private-keychain-error');
    } finally { spy.mockRestore(); }
  });
  it('keeps the Xiaohongshu check identifiable on credential read timeout', async () => {
    const { app, services } = setup();
    const original = services.secretStore.get.bind(services.secretStore);
    const spy = vi.spyOn(services.secretStore, 'get').mockImplementation(key => key === XIAOHONGSHU_COOKIE_KEY ? new Promise(() => {}) : original(key));
    try {
      const result = await app.inject({ method: 'GET', url: '/api/v1/service/self-check', headers });
      expect(result.statusCode).toBe(200);
      expect(result.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'xiaohongshu-cookie', label: '小红书授权', status: 'warn', detail: '读取小红书授权凭据超时' }),
        expect.objectContaining({ key: 'ffmpeg' }),
      ]));
    } finally { spy.mockRestore(); }
  });
  it('keeps cookies write-only, rejects invalid values and clears credentials on reset', async () => {
    const { app, services } = setup();
    const saved = await app.inject({ method: 'POST', url: '/api/v1/settings/xiaohongshu-cookie', headers, payload: { cookie: 'web_session=test-secret; a1=abc' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.xiaohongshuCookie).toEqual({ hasCookie: true });
    expect(saved.body).not.toContain('test-secret');
    expect(await services.platformCookie('xiaohongshu')).toBe('web_session=test-secret; a1=abc');
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/settings/xiaohongshu-cookie', headers, payload: { cookie: 'a1=anonymous' } });
    expect(rejected.statusCode).toBe(422);
    expect(await services.secretStore.get(XIAOHONGSHU_COOKIE_KEY)).toContain('test-secret');
    const reset = await app.inject({ method: 'POST', url: '/api/v1/settings/reset', headers, payload: { confirm: 'RESET', keepRecordings: true } });
    expect(reset.statusCode).toBe(200);
    expect(await services.secretStore.has(XIAOHONGSHU_COOKIE_KEY)).toBe(false);
  });
  it('round-trips host-to-share associations with config while importing old interval settings', async () => {
    const { app, services } = setup();
    services.rooms.create({ platform: 'xiaohongshu', url: profile, displayName: '主播', enabled: false });
    services.db.prepare('INSERT INTO xiaohongshu_sources (profile_url,room_url) VALUES (?,?)').run(profile, roomUrl);
    const exported = await app.inject({ method: 'GET', url: '/api/v1/config/export', headers });
    expect(exported.json().config.xiaohongshuSources).toEqual([{ profileUrl: profile, roomUrl, profileRequestUrl: null }]);
    services.db.exec('DELETE FROM xiaohongshu_sources');
    const config = exported.json().config;
    config.settings.recordingDirectory = '/tmp/xiaohongshu-test';
    delete config.settings.checkIntervalSec.xiaohongshu;
    const imported = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers, payload: { config } });
    expect(imported.statusCode).toBe(200);
    expect(services.settings.load()!.checkIntervalSec.xiaohongshu).toBe(120);
    expect(services.db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url=?').get(profile)).toEqual({ room_url: roomUrl });
  });
});
