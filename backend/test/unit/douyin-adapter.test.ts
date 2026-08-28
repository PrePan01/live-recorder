import { describe, expect, it } from 'vitest';
import { DouyinAdapter } from '../../src/platform/douyin.js';
import { AppError } from '../../src/types/error.js';

function mockFetcher(resolver: (url: string) => unknown): typeof fetch {
  return async (url) =>
    new Response(JSON.stringify(resolver(String(url))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
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
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
    expect(result.status).toBe('live');
    expect(result.streamSessionId).toBe('123456');
    expect(result.streamTitle).toBe('抖音直播间');
    expect(result.displayName).toBe('抖音主播');
    expect(result.availableQualities).toEqual(['original', '1080p', '720p', '360p']);
  });

  it('reports offline when status is not 2', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ status: 4 })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
    expect(result.status).toBe('offline');
  });

  it('reports restricted when live but no stream url (needs cookie)', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ stream_url: {} })));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
  });

  it('maps network failures to NETWORK_UNAVAILABLE', async () => {
    const a = new DouyinAdapter(() => Promise.reject(new TypeError('fetch failed')));
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
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
    const original = await a.getStreamUrl('https://live.douyin.com/123456', 'original');
    expect(original.url).toBe('https://pull.example.com/full.flv');
    expect(original.format).toBe('flv');
    expect(original.actualQuality).toBe('original');
    expect(original.headers?.['Referer']).toBe('https://live.douyin.com/123456');

    const hd1 = await a.getStreamUrl('https://live.douyin.com/123456', '1080p');
    expect(hd1.url).toBe('https://pull.example.com/hd1.flv');
    expect(hd1.actualQuality).toBe('1080p');

    const sd1 = await a.getStreamUrl('https://live.douyin.com/123456', '720p');
    expect(sd1.url).toBe('https://pull.example.com/sd1.flv');

    const sd2 = await a.getStreamUrl('https://live.douyin.com/123456', '360p');
    expect(sd2.url).toBe('https://pull.example.com/sd2.flv');
  });

  it('getStreamUrl throws PLATFORM_ACCESS_RESTRICTED when no stream is available', async () => {
    const a = new DouyinAdapter(mockFetcher(() => livePayload({ stream_url: {} })));
    await a.getStreamUrl('https://live.douyin.com/123456', 'original').catch((err) => {
      expect((err as AppError).code).toBe('PLATFORM_ACCESS_RESTRICTED');
    });
  });

  it('maps empty responses (anti-crawl/no cookie) to PLATFORM_ACCESS_RESTRICTED', async () => {
    const a = new DouyinAdapter(async () => new Response('', { status: 200 }) as unknown as Response);
    const result = await a.checkLiveStatus('https://live.douyin.com/123456');
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
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
