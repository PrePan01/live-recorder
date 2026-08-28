import { describe, expect, it } from 'vitest';
import { BilibiliAdapter } from '../../src/platform/bilibili.js';
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
    code: 0,
    message: '0',
    data: {
      live_status: 1,
      room_info: { title: '测试直播间' },
      anchor_info: { base_info: { uname: '测试主播' } },
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_stream',
              format: [
                {
format_name: 'flv',
                      codec: [
                        {
                          codec_name: 'avc',
                          current_qn: 10000,
                          accept_qn: [10000, 400, 150, 80],
                          quality_description: [
                            { qn: 10000, desc: '原画' },
                            { qn: 400, desc: '蓝光' },
                            { qn: 150, desc: '高清' },
                            { qn: 80, desc: '流畅' },
                          ],
                          base_url: '/live-bvc/123.flv?',
                          url_info: [{ host: 'https://cn-bvc.example.com', extra: 'token=abc' }],
                        },
                      ],
                },
              ],
            },
          ],
        },
      },
      ...overrides,
    },
  };
}

describe('BilibiliAdapter', () => {
  it('validates, normalizes and parses room urls', () => {
    const a = new BilibiliAdapter();
    expect(a.validateUrl('https://live.bilibili.com/123')).toBe(true);
    expect(a.validateUrl('https://m.live.bilibili.com/123')).toBe(true);
    expect(a.validateUrl('https://live.bilibili.com/abc')).toBe(false);
    expect(a.validateUrl('https://example.com/123')).toBe(false);
    expect(a.normalizeUrl('https://live.bilibili.com/9/?x=1#t')).toBe('https://live.bilibili.com/9');
    expect(a.parseRoomId('https://live.bilibili.com/123456?spm=1')).toBe(123456);
    expect(a.parseRoomId('https://example.com/1')).toBeNull();
  });

  it('reports live with session id, title, displayName and qualities', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.streamSessionId).toBe('123456');
    expect(result.streamTitle).toBe('测试直播间');
    expect(result.displayName).toBe('测试主播');
    expect(result.availableQualities).toEqual(['original', '1080p', '720p', '360p']);
  });

  it('reports offline when live_status is not 1', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload({ live_status: 0 })));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('offline');
  });

  it('reports restricted when live but no playable stream (needs cookie)', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload({ playurl_info: { playurl: { stream: [] } } })));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('restricted');
    expect(result.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
  });

  it('maps network failures to NETWORK_UNAVAILABLE', async () => {
    const a = new BilibiliAdapter(() => Promise.reject(new TypeError('fetch failed')));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });

  it('maps non-zero api code to PLATFORM_CHANGED', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => ({ code: -404, data: null })));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('PLATFORM_CHANGED');
  });

  it('returns error for an invalid url', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus('https://example.com/1');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('ROOM_LINK_INVALID');
  });

  it('getStreamUrl returns flv url with headers and actual quality', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload()));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', 'original');
    expect(result.url).toBe('https://cn-bvc.example.com/live-bvc/123.flv?token=abc');
    expect(result.format).toBe('flv');
    expect(result.actualQuality).toBe('original');
    expect(result.headers?.['Referer']).toBe('https://live.bilibili.com/123456');
    expect(result.headers?.['User-Agent']).toBeTruthy();
  });

  it('getStreamUrl selects best quality not exceeding the target', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload()));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', '1080p');
    expect(result.actualQuality).toBe('1080p');
  });

  it('getStreamUrl falls back to the highest available when target is unavailable', async () => {
    const payload = livePayload();
    (payload as { data: { playurl_info: { playurl: { stream: { format: { codec: { accept_qn: number[] }[] }[] }[] } } } }).data.playurl_info.playurl.stream[0].format[0].codec[0].accept_qn = [80];
    (payload as { data: { playurl_info: { playurl: { stream: { format: { codec: { current_qn: number }[] }[] }[] } } } }).data.playurl_info.playurl.stream[0].format[0].codec[0].current_qn = 80;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', 'original');
    expect(result.actualQuality).toBe('360p');
  });

  it('getStreamUrl throws PLATFORM_ACCESS_RESTRICTED when no stream url is available', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload({ playurl_info: { playurl: { stream: [] } } })));
    await expect(a.getStreamUrl('https://live.bilibili.com/123456', 'original')).rejects.toThrowError(AppError);
    await a.getStreamUrl('https://live.bilibili.com/123456', 'original').catch((err) => {
      expect((err as AppError).code).toBe('PLATFORM_ACCESS_RESTRICTED');
    });
  });

  it('passes cookie through to the api request', async () => {
    let sentCookie: string | undefined;
    let hasTimeoutSignal = false;
    const a = new BilibiliAdapter(async (url, init) => {
      sentCookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
      hasTimeoutSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });
    await a.checkLiveStatus('https://live.bilibili.com/123456', 'SESSDATA=xxx;buvid3=yyy');
    expect(sentCookie).toBe('SESSDATA=xxx;buvid3=yyy');
    expect(hasTimeoutSignal).toBe(true);
  });
});
