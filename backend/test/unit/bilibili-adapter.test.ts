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

/** getRoomPlayInfo 现响应不含 room_info/anchor_info，名称改由 get_anchor_in_room/get_info 补充。 */
function routeFetcher(play: unknown, anchor?: unknown, info?: unknown): typeof fetch {
  return mockFetcher((url) => {
    if (url.includes('get_anchor_in_room')) return anchor ?? { code: 0, data: { info: {} } };
    if (url.includes('Room/get_info')) return info ?? { code: 0, data: {} };
    return play;
  });
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

/**
 * 取 livePayload() 里的第一个 flv codec，便于按真实接口语义调整档位字段。
 * `current_qn` 是服务端对本次 qn 请求的实际答复（真话），`accept_qn` 只是该流支持的档位清单。
 */
function flvCodec(payload: unknown): Record<string, unknown> {
  const p = payload as {
    data: { playurl_info: { playurl: { stream: { format: { codec: Record<string, unknown>[] }[] }[] } } };
  };
  return p.data.playurl_info.playurl.stream[0].format[0].codec[0];
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

  it('reports live with a per-broadcast session id, title, displayName and qualities', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload({ live_time: 1787891234 })));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.streamSessionId).toBe('123456:1787891234');
    expect(result.platformStartedAt).toBe('2026-08-28T04:27:14.000Z');
    expect(result.streamTitle).toBe('测试直播间');
    expect(result.displayName).toBe('测试主播');
    expect(result.availableQualities).toEqual(['original', '1080p', '720p', '360p']);
  });

  /**
   * accept_qn 里含 10000 不代表能拿到原画：未登录时服务端授予的上限（current_qn=250）才是真话。
   * 不加这层过滤，界面/契约会告诉匿名用户「可用原画」。
   */
  it('availableQualities 不超过服务端实际授予的上限（未登录不谎报原画）', async () => {
    const payload = livePayload();
    flvCodec(payload).accept_qn = [10000, 400, 250];
    flvCodec(payload).current_qn = 250;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.availableQualities).toEqual(['720p']);
  });

  it('uses a unique fallback session id when live_time is absent', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload()));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.streamSessionId).toMatch(/^live_123456_\d+$/);
    expect(result.platformStartedAt).toBeUndefined();
  });

  it('reports offline when live_status is not 1', async () => {
    const a = new BilibiliAdapter(mockFetcher(() => livePayload({ live_status: 0 })));
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('offline');
  });

  it('fills displayName and title from meta endpoints when getRoomPlayInfo omits them (#91)', async () => {
    // 真实响应：getRoomPlayInfo 不再返回 room_info/anchor_info。
    const play = livePayload({ live_time: 1787891234 });
    delete (play as { data: Record<string, unknown> }).data.room_info;
    delete (play as { data: Record<string, unknown> }).data.anchor_info;
    const a = new BilibiliAdapter(
      routeFetcher(play, { code: 0, data: { info: { uname: 'LofiGirl' } } }, { code: 0, data: { title: '学习工作背景音乐' } }),
    );
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.displayName).toBe('LofiGirl');
    expect(result.streamTitle).toBe('学习工作背景音乐');
  });

  it('keeps name from play response when present and tolerates meta endpoint failures', async () => {
    const a = new BilibiliAdapter(
      routeFetcher(livePayload({ live_time: 1787891234 }), null, null),
    );
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('live');
    expect(result.displayName).toBe('测试主播');
    expect(result.streamTitle).toBe('测试直播间');
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

  it('treats 5xx as a retryable platform hiccup instead of "接口有变动"，且不把状态码给用户看', async () => {
    const a = new BilibiliAdapter(async () => new Response('', { status: 503 }) as unknown as Response);
    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).not.toContain('503');
    expect(result.error?.details?.httpStatus).toBe(503);
  });

  it('retries a transient playback-api failure before reporting the room unavailable', async () => {
    let playRequests = 0;
    const a = new BilibiliAdapter(async (url) => {
      if (String(url).includes('getRoomPlayInfo')) {
        playRequests += 1;
        if (playRequests === 1) return new Response('', { status: 503 }) as unknown as Response;
      }
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });

    const result = await a.checkLiveStatus('https://live.bilibili.com/123456');
    expect(playRequests).toBe(2);
    expect(result.status).toBe('live');
  });

  it('serializes concurrent playback-api requests from polling and recording recovery', async () => {
    let inFlight = 0;
    let peak = 0;
    const a = new BilibiliAdapter(async (url) => {
      if (String(url).includes('getRoomPlayInfo')) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });

    const [first, second] = await Promise.all([
      a.checkLiveStatus('https://live.bilibili.com/111'),
      a.checkLiveStatus('https://live.bilibili.com/222'),
    ]);
    expect(first.status).toBe('live');
    expect(second.status).toBe('live');
    expect(peak).toBe(1);
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

  it('getStreamUrl reports the tier the server actually granted', async () => {
    const payload = livePayload();
    // 服务端按请求授予 400：current_qn 与最终 URL 的 qn 参数一致。
    flvCodec(payload).current_qn = 400;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', '1080p');
    expect(result.actualQuality).toBe('1080p');
  });

  it('getStreamUrl falls back to the granted tier when the target is unavailable', async () => {
    const payload = livePayload();
    flvCodec(payload).accept_qn = [80];
    flvCodec(payload).current_qn = 80;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', 'original');
    expect(result.actualQuality).toBe('360p');
  });

  /**
   * 回归：未登录时 accept_qn 依然会列出 10000（原画），但服务端只给 250（超清）。
   * 曾用 accept_qn 推断画质 → 历史页显示「原画」而文件其实是超清，且 expectedQuality 一致性
   * 提示也不会触发（谎报与设置一致）。必须以 current_qn 为准。
   */
  it('getStreamUrl 未登录时报告服务端实际授予的档位而非 accept_qn 里的原画（回归）', async () => {
    const payload = livePayload();
    // 实测匿名响应：accept_qn=[10000,400,250]、current_qn=250、URL 的 qn=250。
    flvCodec(payload).accept_qn = [10000, 400, 250];
    flvCodec(payload).current_qn = 250;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', 'original');
    expect(result.actualQuality).toBe('720p');
    expect(result.actualQuality).not.toBe('original');
  });

  it('getStreamUrl reports the granted tier even when it exceeds the requested one', async () => {
    const payload = livePayload();
    // 服务端可能给得比请求更高（匿名实测：请求 qn=150 仍返回 current_qn=250）。
    flvCodec(payload).accept_qn = [10000, 400, 250];
    flvCodec(payload).current_qn = 250;
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', '360p');
    expect(result.actualQuality).toBe('720p');
  });

  it('getStreamUrl 多 codec 时选择最接近目标档位的流（而非首个原画 codec）', async () => {
    const payload = livePayload();
    const p = payload as { data: { playurl_info: { playurl: { stream: { format: { codec: Array<Record<string, unknown>> }[] }[] }[] } } };
    // 构造两个 codec：第一个仅原画（current=10000），第二个服务端授予 720p（current=150）。
    p.data.playurl_info.playurl.stream[0].format[0].codec = [
      { codec_name: 'avc', current_qn: 10000, accept_qn: [10000], base_url: '/live/avc_orig.flv', url_info: [{ host: 'https://b1.example.com', extra: '' }] },
      { codec_name: 'hevc', current_qn: 150, accept_qn: [10000, 150], base_url: '/live/hevc_720.flv', url_info: [{ host: 'https://b2.example.com', extra: '' }] },
    ];
    const a = new BilibiliAdapter(mockFetcher(() => payload));
    const result = await a.getStreamUrl('https://live.bilibili.com/123456', '720p');
    expect(result.actualQuality).toBe('720p');
    expect(result.url).toContain('b2.example.com');
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
      if (String(url).includes('getRoomPlayInfo')) {
        sentCookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
        hasTimeoutSignal = init?.signal instanceof AbortSignal;
      }
      return new Response(JSON.stringify(livePayload()), { status: 200 }) as unknown as Response;
    });
    await a.checkLiveStatus('https://live.bilibili.com/123456', 'SESSDATA=xxx;buvid3=yyy');
    expect(sentCookie).toBe('SESSDATA=xxx;buvid3=yyy');
    expect(hasTimeoutSignal).toBe(true);
  });
});
