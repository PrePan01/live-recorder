import { describe, expect, it } from 'vitest';
import { DouyinAdapter } from '../../src/platform/douyin.js';

function mockFetcher(resolver: (url: string) => unknown): typeof fetch {
  return async (url) =>
    new Response(JSON.stringify(resolver(String(url))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
}

function statusFetcher(status: number): typeof fetch {
  return async () => new Response('', { status }) as unknown as Response;
}

function livePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    status_code: 0,
    data: {
      data: [
        {
          id: '123456',
          status: 2,
          title: '抖音直播间',
          user: { nickname: '抖音主播' },
          stream_url: {
            flv_pull_url: {
              FULL_HD1: 'https://pull.example.com/full.flv',
              HD1: 'https://pull.example.com/hd1.flv',
              SD1: 'https://pull.example.com/sd1.flv',
              SD2: 'https://pull.example.com/sd2.flv',
            },
            default_resolution: 'FULL_HD1',
          },
          ...overrides,
        },
      ],
    },
  };
}

describe('DouyinAdapter', () => {
  it('validates, normalizes and parses room urls', () => {
    const a = new DouyinAdapter();
    expect(a.validateUrl('https://live.douyin.com/123')).toBe(true);
    expect(a.validateUrl('https://live.douyin.com/abc')).toBe(false);
    expect(a.validateUrl('https://example.com/123')).toBe(false);
    expect(a.normalizeUrl('https://live.douyin.com/9/?x=1#t')).toBe('https://live.douyin.com/9');
    expect(a.parseRoomId('https://live.douyin.com/123456?x=1')).toBe('123456');
    expect(a.parseRoomId('https://example.com/1')).toBeNull();
  });

  it('reports live with session id, title, displayName and qualities', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('live');
    expect(result.streamSessionId).toBe('123456');
    expect(result.streamTitle).toBe('抖音直播间');
    expect(result.displayName).toBe('抖音主播');
    expect(result.availableQualities).toEqual(['original', '1080p', '720p', '360p']);
  });

  it('falls back to title as displayName when nickname is missing (添加抖音房间显示名检测)', async () => {
    // user 缺 nickname、仅有 title：displayName 应用标题兜底，避免添加房间显示名为空。
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ user: {} })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('live');
    expect(result.displayName).toBe('抖音直播间');
    expect(result.streamTitle).toBe('抖音直播间');
    expect(result.titleSource).toBe('adapter');
    expect(result.titleFallbackUsed).toBe(false);
  });

  it('resolves anchor nickname from the room page when enter API lacks user.nickname (验收 #2a)', async () => {
    // 抖音接口结构变更：enter 不再返回 user.nickname → 从直播间页面 data-anchor-info 解析主播昵称。
    const fetcher = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/webcast/room/web/enter')) {
        return new Response(JSON.stringify(livePayload({ user: {} })), { status: 200 });
      }
      return new Response(
        `<html><body><div data-anchor-info="{&quot;nickname&quot;:&quot;青泠&quot;,&quot;avatar&quot;:&quot;x&quot;}">x</div></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;
    const a = new DouyinAdapter(fetcher);
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('live');
    expect(result.displayName).toBe('青泠');
    expect(result.streamTitle).toBe('抖音直播间');
    expect(result.titleSource).toBe('adapter');
  });

  it('reports offline when status is not 2', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ status: 4 })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('offline');
  });

  it('treats a newly-live room without a stream url as a retryable platform delay, not an authorization failure', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ stream_url: {} })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain('正在等待平台生成流地址');
  });

  it('rechecks once when a room transitions from offline to live before its stream url is ready', async () => {
    let requests = 0;
    const a = new DouyinAdapter(async () => {
      requests += 1;
      return new Response(JSON.stringify(requests === 1 ? livePayload({ stream_url: {} }) : livePayload()), { status: 200 }) as unknown as Response;
    });

    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(requests).toBe(2);
    expect(result.status).toBe('live');
  });

  it('maps network failures to NETWORK_UNAVAILABLE', async () => {
    const a = new DouyinAdapter(() => Promise.reject(new TypeError('fetch failed')));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });

  it('retries a transient upstream HTTP failure instead of reporting PLATFORM_CHANGED', async () => {
    let requests = 0;
    const a = new DouyinAdapter(async () => {
      requests += 1;
      return requests === 1
        ? new Response('', { status: 503 }) as unknown as Response
        : new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });

    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=valid');
    expect(requests).toBe(2);
    expect(result.status).toBe('live');
  });

  it('reports persistent 429/5xx as retryable network failure, not PLATFORM_CHANGED', async () => {
    const a = new DouyinAdapter(async () => new Response('', { status: 429 }) as unknown as Response);
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=valid');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });

  it('returns error for an invalid url', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus('https://example.com/1');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('ROOM_LINK_INVALID');
  });

  it('getStreamUrl picks the requested quality and falls back gracefully', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload()));
    const original = await a.getStreamUrl('https://live.douyin.com/123456', 'original', 'sessionid=x');
    expect(original.url).toBe('https://pull.example.com/full.flv');
    expect(original.format).toBe('flv');
    expect(original.actualQuality).toBe('original');
    expect(original.headers?.['Referer']).toBe('https://live.douyin.com/123456');

    const hd1 = await a.getStreamUrl('https://live.douyin.com/123456', '1080p', 'sessionid=x');
    expect(hd1.url).toBe('https://pull.example.com/hd1.flv');
    expect(hd1.actualQuality).toBe('1080p');

    const sd1 = await a.getStreamUrl('https://live.douyin.com/123456', '720p', 'sessionid=x');
    expect(sd1.url).toBe('https://pull.example.com/sd1.flv');

    const sd2 = await a.getStreamUrl('https://live.douyin.com/123456', '360p', 'sessionid=x');
    expect(sd2.url).toBe('https://pull.example.com/sd2.flv');
  });

  it('getStreamUrl reports a retryable platform delay when a newly-live room has no stream url', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ stream_url: {} })));
    await expect(a.getStreamUrl('https://live.douyin.com/123456', 'original', 'sessionid=x')).rejects.toMatchObject({
      code: 'NETWORK_UNAVAILABLE',
      retryable: true,
    });
  });

  it('maps empty responses (anti-crawl) to PLATFORM_ACCESS_RESTRICTED', async () => {
    const a = new DouyinAdapter(async () => new Response('', { status: 200 }) as unknown as Response);
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
  });

  it('does not treat a transient 10011 as an expired cookie', async () => {
    // `10011` 也会携带“服务繁忙，请稍后重试”，此时设置页的登录态仍有效；
    // 不能以一次房间检测熔断所有房间并要求重新授权。
    const a = new DouyinAdapter(mockFetcher(() => ({ status_code: 10011, data: { message: 'Request params error', prompts: '当前服务繁忙，请稍后重试' } })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=expired');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });

  it('keeps the global re-authorization path for an explicit expired-session response', async () => {
    const a = new DouyinAdapter(mockFetcher(() => ({ status_code: 8, data: { message: '请先登录' } })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=expired');
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('DOUYIN_COOKIE_EXPIRED');
  });

  it('maps unexpected structure without cookie signal to PLATFORM_CHANGED', async () => {
    // 结构异常但非凭证特征 → 仍判平台变动（真接口变更）。
    const a = new DouyinAdapter(mockFetcher(() => ({ status_code: 99999, foo: 'bar' })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=xxx');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('PLATFORM_CHANGED');
  });

  it('把"没有房间条目"判成未开播，而不是接口变动（下播房间误报 PLATFORM_CHANGED 回归）', async () => {
    // 抖音对不在播的房间返回 status_code=0 但没有任何房间条目：以前会落到 PLATFORM_CHANGED，
    // 已下播的房间于是每个检测周期都报一次"平台接口有变动"（实测刷出 150+ 条告警）。
    const empty = new DouyinAdapter(mockFetcher(() => ({ status_code: 0, data: { data: [] } })));
    const emptyResult = await empty.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(emptyResult.status).toBe('offline');
    expect(emptyResult.error).toBeUndefined();

    // data.data 直接缺失也是同一种情况。
    const missing = new DouyinAdapter(mockFetcher(() => ({ status_code: 0, data: {} })));
    const missingResult = await missing.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=x');
    expect(missingResult.status).toBe('offline');

    // 取流时同样不该说成接口变动。
    const stream = new DouyinAdapter(mockFetcher(() => ({ status_code: 0, data: { data: [] } })));
    await expect(stream.getStreamUrl('https://live.douyin.com/123456', 'original', 'sessionid=x')).rejects.toMatchObject({
      code: 'RECORDING_NOT_AVAILABLE',
    });
  });

  it('maps 抖音 444（边缘节点掐断连接）to a retryable outage, never an authorization failure', async () => {
    // 444 会在有效登录态下偶发出现；不能让设置页显示“已登录”而监控页要求重新授权。
    const a = new DouyinAdapter(statusFetcher(444));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=stale');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
    // 用户看不懂 HTTP 状态码：绝不能出现在给用户看的文案里（技术细节只留在 details）。
    expect(result.error?.message).not.toContain('444');
    expect(result.error?.details?.httpStatus).toBe(444);
  });

  it('抖音未授权（无 Cookie）时不发任何平台请求，直接报平台访问受限', async () => {
    // 匿名 enter 请求结果不可靠：可能返回看似正常的数据（房间被当成离线，卡片上看不到报错），
    // 也可能长时间不返回把房间留在「检测中」。未登录必须走确定性失败，提示去设置登录授权。
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return new Response('', { status: 444 }) as unknown as Response;
    });
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
    expect(calls).toBe(0);
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toBe('平台访问受限，请检查抖音授权');
  });

  it('getStreamUrl 未授权时同样拒绝匿名取流', async () => {
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });
    await expect(a.getStreamUrl('https://live.douyin.com/123456', 'original')).rejects.toMatchObject({
      code: 'PLATFORM_ACCESS_RESTRICTED',
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it('retries once when the edge drops the request (444 then success)', async () => {
    // 偶发掐断要在重试后自愈，而不是把用户赶去重新登录。
    let calls = 0;
    const a = new DouyinAdapter(async () => {
      calls += 1;
      return calls === 1
        ? (new Response('', { status: 444 }) as unknown as Response)
        : (new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response);
    });
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=ok');
    expect(result.status).toBe('live');
    expect(calls).toBe(2);
  });

  it('serializes concurrent enter requests from polling and recording recovery', async () => {
    let inFlight = 0;
    let peak = 0;
    const a = new DouyinAdapter(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });

    const [first, second] = await Promise.all([
      a.checkLiveStatus('https://live.douyin.com/111', 'sessionid=ok'),
      a.checkLiveStatus('https://live.douyin.com/222', 'sessionid=ok'),
    ]);
    expect(first.status).toBe('live');
    expect(second.status).toBe('live');
    expect(peak).toBe(1);
  });

  it('never leaks other unexpected HTTP statuses into user-facing copy', async () => {
    const a = new DouyinAdapter(statusFetcher(451));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=ok');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.message).not.toContain('451');
    expect(result.error?.details?.httpStatus).toBe(451);
  });

  it('passes cookie through and uses web_rid param (douyin API P0 fix)', async () => {
    let sentCookie: string | undefined;
    let sentUrl = '';
    let hasTimeoutSignal = false;
    const a = new DouyinAdapter(async (url, init) => {
      sentUrl = String(url);
      sentCookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
      hasTimeoutSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });
    await a.checkLiveStatus('https://live.douyin.com/123456', 'sessionid=xxx');
    expect(sentCookie).toBe('sessionid=xxx');
    expect(hasTimeoutSignal).toBe(true);
    // P0：抖音接口须用 web_rid，room_id_str 会返回 status_code=10011。
    expect(sentUrl).toContain('web_rid=123456');
    expect(sentUrl).not.toContain('room_id_str');
  });
});
