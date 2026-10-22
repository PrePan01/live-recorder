import { describe, expect, it, vi } from 'vitest';
import { XiaohongshuAdapter, parseXhsState } from '../../src/platform/xiaohongshu.js';
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from '../../src/platform/xiaohongshu-url.js';
import { createXiaohongshuDanmakuAdapter } from '../../src/danmaku/adapters/xiaohongshu.js';
import { validateXiaohongshuCookie, checkXiaohongshuCookieStatus } from '../../src/security/xiaohongshu-cookie.js';
import { resetUnknownStatusCounter, unknownStatusSnapshot } from '../../src/platform/status-fallback.js';

const host = '6407d96c000000001f032ae5';
const profile = `https://www.xiaohongshu.com/user/profile/${host}`;
const roomUrl = 'https://www.xiaohongshu.com/livestream/123?xsec_token=required';
function page(overrides = {}, roomId = '123') {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({ liveStream: { liveStatus: 'success', roomData: {
    hostInfo: { nickName: '主播', avatar: 'https://sns-avatar-qc.xhscdn.com/avatar.jpg' },
    roomInfo: { status: 2, roomId, roomTitle: 'undefined直播', deeplink: `xhsdiscover://live_audience?host_id=${host}`,
      pullConfig: JSON.stringify({ height: 720, h264: [{ quality_type: 'HD', master_url: 'https://live-source-play.xhscdn.com/live/123.flv?sign=required' }] }), ...overrides },
  } } })}</script>`;
}

describe('XiaohongshuAdapter', () => {
  it.each([
    [[1080, 720, 540, 360], 540, '540p'],
    [[1080, 720, 360], 360, '360p'],
    [[1080, 720], 720, '720p'],
  ] as const)('selects 540p or the available fallback from dimensions %j', async (heights, selected, actualQuality) => {
    const pullConfig = JSON.stringify({ h264: heights.map(height => ({
      height, master_url: `https://live.xhscdn.com/${height}.flv`,
    })) });
    const adapter = new XiaohongshuAdapter((async () => new Response(page({ pullConfig }))) as typeof fetch);
    expect(await adapter.getStreamUrl(roomUrl, '540p')).toMatchObject({
      actualQuality, url: `https://live.xhscdn.com/${selected}.flv`,
    });
    expect((await adapter.checkLiveStatus(roomUrl)).availableQualities?.includes('540p')).toBe(heights.includes(540 as never));
  });

  it('keeps access tokens, strips only tracking, and rejects lookalike/credential hosts', () => {
    expect(normalizeXiaohongshuUrl(roomUrl + '&track_id=abc')).toBe(roomUrl);
    expect(parseXiaohongshuUrl('https://www.xiaohongshu.com.evil.test/livestream/123')).toBeNull();
    expect(parseXiaohongshuUrl('https://token@www.xiaohongshu.com/livestream/123')).toBeNull();
    expect(parseXhsState('<script>window.__INITIAL_STATE__={"empty":undefined,"title":"undefined"};</script>')).toEqual({ empty: null, title: 'undefined' });
  });
  it('retains a profile access token separately from its stable canonical identity', async () => {
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/user/profile')
      ? `<script>window.__INITIAL_STATE__=${JSON.stringify({ user: { userPageData: { basicInfo: { live: { liveStatus: 2, roomId: '123', xsecToken: 'room-token' } } } } })}</script>`
      : page()));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch);
    expect(await adapter.resolveRoomUrl(profile + '?xsec_token=profile-token')).toBe('https://www.xiaohongshu.com/livestream/123?xsec_token=room-token');
    await adapter.checkLiveStatus(profile);
    expect(fetcher.mock.calls[0]![0]).toContain('xsec_token=profile-token');
    expect(fetcher.mock.calls[1]![0]).toContain('xsec_token=room-token');
  });
  it('rejects a profile share without a resolvable broadcast instead of storing the profile', async () => {
    const fetcher = vi.fn(async (raw: string) => raw.includes('xhslink.com')
      ? new Response(null, { status: 302, headers: { location: profile + '?xsec_token=profile-share' } })
      : new Response('<html>profile</html>'));
    const profiles = new Map<string, string>();
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, {
      load: () => undefined, save: () => {}, loadProfile: key => profiles.get(key), saveProfile: (key, value) => { profiles.set(key, value); },
    });
    await expect(adapter.resolveRoomUrl('https://xhslink.com/a/profile')).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_RESTRICTED' });
    expect(profiles.get(profile)).toContain('xsec_token=profile-share');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('deduplicates different room shares to one host and persists a token-bearing source for restarts', async () => {
    const values = new Map<string, string>();
    const sources = { load: (key: string) => values.get(key), save: (key: string, value: string) => { values.set(key, value); } };
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/user/profile') ? '<html>profile without live signal</html>' : page()));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, sources);
    expect(await adapter.resolveRoomUrl(roomUrl)).toBe(roomUrl);
    expect(await adapter.resolveRoomUrl(roomUrl + '&track_id=abc')).toBe(roomUrl);
    expect(values.get(profile)).toContain('xsec_token=required');
    const restarted = new XiaohongshuAdapter(fetcher as typeof fetch, sources);
    const stream = await restarted.getStreamUrl(profile, 'original', 'web_session=test');
    expect(stream).toMatchObject({ format: 'flv', actualQuality: '720p' });
    expect(stream.headers).not.toHaveProperty('Cookie');
  });
  it('discovers a new room URL exposed by the host profile and verifies its host', async () => {
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/user/profile')
      ? `<script>window.__INITIAL_STATE__={"user":{"liveLink":"https://www.xiaohongshu.com/livestream/456?xsec_token=new"}}</script>`
      : page({}, '456')));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch);
    expect(await adapter.checkLiveStatus(profile)).toMatchObject({ status: 'live', streamSessionId: '456' });
    expect(fetcher.mock.calls[1]![0]).toContain('xsec_token=new');
  });
  it('uses the official PC profile live object instead of permanently polling the previous room', async () => {
    let requested = '';
    const fetcher = vi.fn(async (raw: string) => {
      requested = raw;
      return new Response(raw.includes('/user/profile')
        ? `<script>window.__INITIAL_STATE__=${JSON.stringify({ user: { userPageData: { basicInfo: { live: { liveStatus: 2, roomId: '789', xsecToken: 'new-token' } } } } })}</script>`
        : page({}, '789'));
    });
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, { load: () => roomUrl, save: () => {} });
    expect(await adapter.checkLiveStatus(profile)).toMatchObject({ status: 'live', streamSessionId: '789' });
    expect(requested).toContain('/livestream/789?xsec_token=new-token');
    expect(fetcher.mock.calls[0]![1]?.headers).toHaveProperty('User-Agent', expect.stringContaining('Mozilla'));
  });
  it('does not misreport a missing profile live signal or access rejection as offline', async () => {
    const adapter = new XiaohongshuAdapter((async () => new Response('<html>profile</html>')) as typeof fetch);
    expect(await adapter.checkLiveStatus(profile)).toMatchObject({ status: 'restricted' });
    for (const status of [403, 406, 429, 500]) {
      const restricted = new XiaohongshuAdapter((async () => new Response('', { status })) as typeof fetch);
      expect((await restricted.checkLiveStatus(roomUrl)).status).not.toBe('offline');
    }
  });
  it('discovers the current room through the official signed profile card when desktop SSR omits live metadata', async () => {
    const native = vi.fn(async () => ({ status: 200, text: JSON.stringify({ success: true, data: { basic_info: {
      nickname: '主播', live: { live_status: 2, room_id: '456', xsec_token: 'fresh' },
    } } }) }));
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/user/profile') ? '<html>profile</html>' : page({}, '456')));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, undefined, native);
    expect(await adapter.checkLiveStatus(profile, 'web_session=local')).toMatchObject({ status: 'live', streamSessionId: '456' });
    expect(native.mock.calls[0]?.[0]).toContain('target_user_id=' + host);
    expect(fetcher.mock.calls[1]?.[0]).toContain('xsec_token=fresh');
  });
  it('does not advertise an unverified original quality when stream dimensions are absent', async () => {
    const adapter = new XiaohongshuAdapter((async () => new Response(page({ pullConfig: JSON.stringify({ h264: [{ quality_type: 'HD', master_url: 'https://live.xhscdn.com/a.flv' }] }) }))) as typeof fetch);
    expect(await adapter.resolveRecordingSource(roomUrl, 'original')).toMatchObject({ status: 'error' });
    expect((await adapter.checkLiveStatus(roomUrl)).availableQualities).toEqual([]);
  });
  it('uses native signing only for rejected authenticated interaction requests', async () => {
    const native = vi.fn(async () => ({ status: 200, text: '{"success":true,"data":{"comments":[]}}' }));
    const adapter = new XiaohongshuAdapter((async () => new Response('', { status: 406 })) as typeof fetch, undefined, native);
    const url = 'https://live-room.xiaohongshu.com/api/sns/red/live/h5/v1/interaction/get_simple_interaction?roomId=123';
    expect((await adapter.request(url, 'web_session=local')).text).toContain('"success":true');
    await expect(adapter.request(url)).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_RESTRICTED' });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('continues recording through a saved share when the profile endpoint is temporarily unavailable', async () => {
    const fetcher = (async (raw: string) => raw.includes('/user/profile') ? new Response('', { status: 503 }) : new Response(page())) as typeof fetch;
    const adapter = new XiaohongshuAdapter(fetcher, { load: () => roomUrl, save: () => {} });
    expect(await adapter.resolveRecordingSource(profile, 'original')).toMatchObject({ status: 'live' });
  });
  it('reports an ended broadcast as offline when the accessible profile offers no new room', async () => {
    const fetcher = (async (raw: string) => new Response(raw.includes('/user/profile') ? '<html>no live metadata</html>' : page({ status: 3 }))) as typeof fetch;
    const adapter = new XiaohongshuAdapter(fetcher, { load: () => roomUrl, save: () => {} });
    expect(await adapter.checkLiveStatus(profile, 'web_session=local')).toMatchObject({ status: 'offline', streamSessionId: '123' });
    expect(await adapter.checkLiveStatus(roomUrl)).toMatchObject({ status: 'offline' });
  });
  it('discovers a new broadcast after an authenticated offline check', async () => {
    let live = false;
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/user/profile')
      ? `<script>window.__INITIAL_STATE__=${JSON.stringify({ user: live ? { liveLink: 'https://www.xiaohongshu.com/livestream/456?xsec_token=new' } : {} })}</script>`
      : raw.includes('/livestream/456') ? page({}, '456') : page({ status: 3 })));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, {
      load: () => roomUrl, save: () => {}, profileForRoom: () => profile,
    });
    expect(await adapter.checkLiveStatus(roomUrl, 'web_session=local')).toMatchObject({ status: 'offline' });
    live = true;
    expect(await adapter.checkLiveStatus(roomUrl, 'web_session=local')).toMatchObject({ status: 'live', streamSessionId: '456' });
  });
  it.each([403, 503])('preserves a profile HTTP %s failure when the saved broadcast has ended', async status => {
    const fetcher = (async (raw: string) => raw.includes('/user/profile')
      ? new Response('', { status }) : new Response(page({ status: 3 }))) as typeof fetch;
    const adapter = new XiaohongshuAdapter(fetcher, { load: () => roomUrl, save: () => {} });
    expect(await adapter.checkLiveStatus(profile, 'web_session=local')).toMatchObject({
      status: status === 403 ? 'restricted' : 'error',
      error: { code: status === 403 ? 'PLATFORM_ACCESS_RESTRICTED' : 'NETWORK_UNAVAILABLE' },
    });
  });
  it('does not replace an associated host with a different host discovered on the page', async () => {
    const adapter = new XiaohongshuAdapter((async (raw: string) => new Response(raw.includes('/user/profile')
      ? `<script>window.__INITIAL_STATE__=${JSON.stringify({ liveLink: roomUrl })}</script>`
      : page({ deeplink: 'xhsdiscover://live_audience?host_id=abcd' }))) as typeof fetch);
    expect(await adapter.checkLiveStatus(profile)).toMatchObject({ status: 'error', error: { code: 'PLATFORM_CHANGED' } });
  });
  it('recognizes explicit end state and refreshes the stream for every recording-source request', async () => {
    const fetcher = vi.fn(async () => new Response(page({ status: 3 })));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch);
    expect(await adapter.resolveRecordingSource(roomUrl, 'original')).toEqual({ status: 'offline' });
    fetcher.mockImplementation(async () => new Response(page()));
    expect(await adapter.resolveRecordingSource(roomUrl, 'original')).toMatchObject({ status: 'live' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors an authoritative ended status even when the landing page still reports live', async () => {
    const native = vi.fn(async () => ({ status: 200, text: '{"success":true,"data":{"status":3}}' }));
    const adapter = new XiaohongshuAdapter((async () => new Response(page())) as typeof fetch, undefined, native);
    expect(await adapter.resolveRecordingSource(roomUrl, '720p', 'web_session=local')).toEqual({ status: 'offline' });
  });
  it('rejects cross-host redirects before sending cookies', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/live' } }));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch);
    await expect(adapter.resolveRoom('https://xhslink.com/a/abcd', 'web_session=secret')).rejects.toMatchObject({ code: 'ROOM_LINK_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('Cookie');
  });
  it('rejects a missing H.264 stream without falsely recording HEVC as AVC', async () => {
    const adapter = new XiaohongshuAdapter((async () => new Response(page({ pullConfig: '{"h265":[{"master_url":"https://live.xhscdn.com/a.flv"}]}' }))) as typeof fetch);
    expect(await adapter.resolveRecordingSource(roomUrl, 'original')).toMatchObject({ status: 'error', error: { code: 'PLATFORM_CHANGED' } });
  });
  it('accepts local Cookie shapes but does not interpret risk-control rejection as expiry', async () => {
    expect(() => validateXiaohongshuCookie('a1=abc; web_session=test')).not.toThrow();
    expect(() => validateXiaohongshuCookie('web_session=test\r\nInjected=true')).toThrow();
    expect(() => validateXiaohongshuCookie('a1=abc')).toThrow();
    expect(await checkXiaohongshuCookieStatus('web_session=test', (async () => new Response('', { status: 406 })) as typeof fetch)).toBe('unknown');
  });
  it('routes unknown HTTP codes through the neutral fallback instead of claiming the API changed', async () => {
    resetUnknownStatusCounter();
    const adapter = new XiaohongshuAdapter((async () => new Response('', { status: 418 })) as typeof fetch);
    await expect(adapter.request('https://live-room.xiaohongshu.com/api/x', 'web_session=t')).rejects.toMatchObject({
      code: 'PLATFORM_CHANGED',
      message: expect.stringContaining('未知'),
    });
    expect(unknownStatusSnapshot().map((entry) => entry.key)).toContain('xiaohongshu|418');
    const gone = new XiaohongshuAdapter((async () => new Response('', { status: 404 })) as typeof fetch);
    await expect(gone.request('https://live-room.xiaohongshu.com/api/x', 'web_session=t')).rejects.toMatchObject({
      message: expect.stringContaining('更新分享链接'),
    });
  });
});

describe('Xiaohongshu danmaku polling', () => {
  it('emits real text shape, deduplicates IDs and cancels an active poll wait', async () => {
    const adapter = new XiaohongshuAdapter();
    vi.spyOn(adapter, 'resolveRoom').mockResolvedValue({ roomId: '123', roomUrl, hostId: host, live: true, data: {}, host: {} });
    vi.spyOn(adapter, 'request').mockResolvedValue({ url: roomUrl, text: JSON.stringify({ success: true, data: {
      comments: [{ id: '1', desc: '你好' }, { id: '1', desc: '你好' }, { id: '2', desc: '再见' }], nextRequestInterval: 1000,
    } }) });
    const controller = new AbortController(), connected = vi.fn();
    const iterator = createXiaohongshuDanmakuAdapter(adapter).collect(roomUrl, null, controller.signal, connected)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ id: 'xiaohongshu:123:1', text: '你好', tMs: null });
    expect((await iterator.next()).value).toMatchObject({ id: 'xiaohongshu:123:2', text: '再见' });
    const pending = iterator.next(); controller.abort();
    expect((await pending).done).toBe(true);
    expect(connected).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(vi.mocked(adapter.request).mock.calls[0]![0]);
    expect(requestUrl.searchParams.get('room_id')).toBe('123');
    expect(requestUrl.searchParams.has('start_timestamp')).toBe(true);
    expect(requestUrl.searchParams.has('roomId')).toBe(false);
  });
  it('surfaces rejected polling to the existing reconnect manager without claiming connected', async () => {
    const adapter = new XiaohongshuAdapter();
    vi.spyOn(adapter, 'resolveRoom').mockResolvedValue({ roomId: '123', roomUrl, hostId: host, live: true, data: {}, host: {} });
    vi.spyOn(adapter, 'request').mockRejectedValue(new Error('小红书访问受限'));
    const connected = vi.fn();
    const iterator = createXiaohongshuDanmakuAdapter(adapter).collect(roomUrl, null, new AbortController().signal, connected)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('小红书访问受限');
    expect(connected).not.toHaveBeenCalled();
  });
});

describe('Xiaohongshu startup and recovery isolation', () => {
  it('starts video from an associated share without profile or signing requests, and coalesces preview/start', async () => {
    const fetcher = vi.fn(async () => new Response(page()));
    const native = vi.fn(async () => { throw new Error('must not be on startup critical path'); });
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, { load: () => roomUrl, save: () => {} }, native);
    const [preview, recording] = await Promise.all([
      adapter.getStreamUrl(profile, '720p', 'web_session=local'),
      adapter.getStreamUrl(profile, '720p', 'web_session=local'),
    ]);
    expect(preview).toEqual(recording);
    expect(recording.streamSessionId).toBe('123');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(roomUrl);
    expect(native).not.toHaveBeenCalled();
    expect(await adapter.checkLiveStatusForStartup(profile, 'web_session=local')).toMatchObject({ status: 'live', streamSessionId: '123' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not block video startup behind a pending background profile request', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (raw: string) => {
      if (raw.includes('/user/profile')) { await waiting; return new Response('<html>profile</html>'); }
      return new Response(page());
    });
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, { load: () => roomUrl, save: () => {} });
    const background = adapter.checkLiveStatus(profile);
    try { expect(await adapter.getStreamUrl(profile, '720p')).toMatchObject({ streamSessionId: '123' }); }
    finally { release(); await background; }
  });
  it('refreshes recovery even during the positive cache TTL and confirms the old broadcast ended', async () => {
    let ended = false;
    const fetcher = vi.fn(async () => new Response(page({ status: ended ? 3 : 2 })));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, { load: () => roomUrl, save: () => {} });
    await adapter.getStreamUrl(profile, '720p');
    ended = true;
    expect(await adapter.resolveRecordingSource(profile, '720p', undefined, { streamSessionId: '123' })).toEqual({ status: 'offline' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never appends a newly discovered broadcast to a previous broadcast recording', async () => {
    let current = roomUrl;
    const sources = { load: () => current, save: (_: string, value: string) => { current = value; } };
    const fetcher = vi.fn(async (raw: string) => new Response(raw.includes('/456') ? page({}, '456') : page({ status: 3 })));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, sources);
    current = 'https://www.xiaohongshu.com/livestream/456?xsec_token=new';
    expect(await adapter.resolveRecordingSource(profile, '720p', undefined, { streamSessionId: '123' })).toEqual({ status: 'offline' });
    expect(current).toContain('/456');
    expect(fetcher.mock.calls[0]?.[0]).toContain('/123');
  });
  it('does not call signed status APIs just to add a share and exposes the current broadcast page', async () => {
    const native = vi.fn(async () => { throw new Error('identity must not sign'); });
    const adapter = new XiaohongshuAdapter((async () => new Response(page())) as typeof fetch, undefined, native);
    expect(await adapter.resolveRoomUrl(roomUrl, 'web_session=local')).toBe(roomUrl);
    expect(native).not.toHaveBeenCalled();
    expect(adapter.getRoomPageUrl(profile)).toBe(roomUrl);
  });
  it('does not share cached stream addresses between credentials', async () => {
    const fetcher = vi.fn(async () => new Response(page()));
    const adapter = new XiaohongshuAdapter(fetcher as typeof fetch, { load: () => roomUrl, save: () => {} });
    await adapter.getStreamUrl(profile, '720p', 'web_session=one');
    await adapter.getStreamUrl(profile, '720p', 'web_session=two');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
