import { describe, expect, it, vi } from 'vitest';
import { DouyuAdapter, douyuAuth } from '../../src/platform/douyu/adapter.js';
import { HuyaAdapter, signHuyaLine } from '../../src/platform/huya/adapter.js';
import { parseHuyaRoom } from '../../src/platform/huya/room.js';
import { decodeHuyaDanmaku } from '../../src/danmaku/adapters/huya.js';
import { createDouyuDanmakuDecoder } from '../../src/danmaku/adapters/douyu.js';
import { readTars, tarsBytes, tarsInt, tarsList, tarsMap, tarsString, tarsStruct } from '../../src/platform/huya/tars.js';
import { normalizeChineseLiveCookie, checkChineseLiveCookie } from '../../src/security/chinese-live-cookie.js';

const room = { room_id: 42, show_status: 1, show_id: 105, show_time: 1750000000, nickname: '主播', room_name: '直播标题' };
const douyu = 'https://www.douyu.com/42';
const huya = 'https://www.huya.com/42';
const rates = [{ rate: 0, name: '原画' }, { rate: 3, name: '超清' }, { rate: 2, name: '高清' }];

function huyaPage(expiration: number, category = 1): string {
  const fm = Buffer.from('prefix_$0_$1_$2_$3').toString('base64');
  const antiCode = new URLSearchParams({ fm, wsTime: expiration.toString(16), ctype: 'huya_live' }).toString();
  const player = {
    data: [{
      gameLiveInfo: { profileRoom: 42, uid: 90000, liveId: '900000001', nick: '主播', introduction: '标题', gid: category },
      gameStreamInfoList: ['al', 'tx'].map(s => ({
        sFlvUrl: `https://${s}.flv.huya.com/huyalive`, sFlvUrlSuffix: 'flv', sFlvAntiCode: antiCode, sStreamName: 'stream',
      })),
    }],
    vMultiStreamInfo: [{ iBitRate: 0, sDisplayName: '蓝光10M' }, { iBitRate: 2000, sDisplayName: '超清' }],
  };
  return `<script>var hyPlayerConfig = { stream: '${Buffer.from(JSON.stringify(player)).toString('base64')}', };</script>`;
}

function huyaToken(): Response {
  const token = tarsStruct(0, tarsString(0, 'wsSecret=renewed&wsTime=ffffffff'));
  const bytes = tarsBytes(7, tarsMap(0, [[tarsString(0, 'tRsp'), tarsBytes(1, token)]]));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length + 4);
  return new Response(new Uint8Array(Buffer.concat([length, bytes])));
}

describe('Douyu and Huya platform adapters', () => {
  it('validates exact room hosts and canonicalizes a topic link and a Huya alias', async () => {
    const dy = new DouyuAdapter(async () => Response.json({ room }));
    const hy = new HuyaAdapter(async () => new Response(huyaPage(0)));
    expect(await dy.resolveRoomUrl('https://m.douyu.com/topic/game?rid=00042')).toBe(douyu);
    expect(await hy.resolveRoomUrl('https://m.huya.com/alias/?share=x')).toBe(huya);
    for (const url of ['https://huya.com/', 'https://www.huya.com/video/play/42', 'https://huya.com/search', 'https://www.huya.com.here.invalid/42', 'https://www.huya.com:888/42']) {
      expect(hy.validateUrl(url)).toBe(false);
    }
  });

  it('resolves a shared Douyu numeric alias when betard returns the legacy closed-room page', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => {
      switch (new URL(String(url)).pathname) {
        case '/betard/6657':
          return new Response('<!doctype html><title>提示信息 -斗鱼</title>您观看的房间已被关闭');
        case '/6657':
          return new Response(String.raw`<script>self.__next_f.push([1,"roomInfo\":{\"room\":{\"room_id\":6979222,\"vipId\":6657}}"])</script>`);
        case '/betard/6979222':
          return Response.json({ room: { ...room, room_id: 6979222, vipId: 6657 } });
        default:
          throw new Error('Unexpected request');
      }
    });
    const adapter = new DouyuAdapter(fetcher);
    const url = await adapter.resolveRoomUrl('https://www.douyu.com/6657?dyshid=share&dyshti=123&dyshci=6');
    expect(url).toBe('https://www.douyu.com/6979222');
    expect(await adapter.checkLiveStatus(url)).toMatchObject({ status: 'live', streamTitle: room.room_name });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/betard/6657', '/6657', '/betard/6979222',
    ]);
  });

  it('reports a missing Douyu room without treating unrelated HTML as a closed-room page', async () => {
    const missing = new DouyuAdapter(async () => new Response(null, { status: 404 }));
    await expect(missing.resolveRoomUrl(douyu)).rejects.toMatchObject({ code: 'ROOM_LINK_INVALID' });
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>unexpected response</html>'));
    await expect(new DouyuAdapter(fetcher).resolveRoomUrl(douyu)).rejects.toMatchObject({ code: 'PLATFORM_CHANGED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('only checks metadata during polling and merges concurrent preview and recording source requests', async () => {
    const play = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/betard/')) return Response.json({ room });
      if (String(url).includes('getEncryption')) {
        return Response.json({ error: 0, data: { key: 'key', rand_str: 'salt', enc_time: 1, enc_data: 'token', is_special: 0 } });
      }
      const req = init?.body as URLSearchParams;
      play(req.get('rate'), req.get('cdn'));
      const cdn = req.get('cdn') || 'al';
      return Response.json({ error: 0, data: {
        rate: req.get('rate') === '0' ? 3 : 2, multirates: rates, selected_cdn: cdn,
        rtmp_url: `https://${cdn}.douyucdn2.cn/live`, rtmp_live: '42.flv?token=x', cdnsWithName: [{ cdn: 'al' }, { cdn: 'tx' }],
      } });
    });
    const adapter = new DouyuAdapter(fetcher);
    expect(await adapter.checkLiveStatus(douyu)).toMatchObject({ status: 'live', streamSessionId: '105' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [preview, recording] = await Promise.all([
      adapter.resolvePreviewSource(douyu, '720p'), adapter.resolveRecordingSource(douyu, '720p'),
    ]);
    expect(preview).toEqual(recording);
    expect(recording).toMatchObject({ status: 'live', stream: { actualQuality: '720p' } });
    expect(play).toHaveBeenCalledTimes(1);
    const next = await adapter.resolveRecordingSource(douyu, '720p', undefined, { previousStreamUrl: 'https://al.douyucdn2.cn/live/42.flv' });
    expect(play).toHaveBeenLastCalledWith('3', 'tx');
    expect(next).toMatchObject({ status: 'live', stream: { actualQuality: '540p', url: expect.stringContaining('tx.douyucdn2.cn') } });
    expect(douyuAuth('42', 1750000000, 'key', 'salt', 1, false)).toMatch(/^[a-f\d]{32}$/);
  });

  it('distinguishes offline, restriction and transient failures', async () => {
    const dy = new DouyuAdapter(async () => Response.json({ room: { ...room, show_status: 2 } }));
    expect(await dy.resolveRecordingSource(douyu, 'original')).toEqual({ status: 'offline' });
    const rateLimited = new DouyuAdapter(async () => new Response(null, { status: 429 }));
    expect(await rateLimited.checkLiveStatus(douyu)).toMatchObject({ status: 'error', error: { code: 'PLATFORM_SERVER_ERROR', retryable: true } });
    const denied = new HuyaAdapter(async () => new Response(null, { status: 403 }));
    expect(await denied.checkLiveStatus(huya)).toMatchObject({ status: 'restricted' });
    expect(parseHuyaRoom('<script>var TT_ROOM_DATA = {"state":"OFF"}; var TT_PROFILE_INFO = {"profileRoom":42,"yyid":90};</script>').live.status).toBe('offline');
    expect(() => parseHuyaRoom('<html>unexpected response</html>')).toThrow();
  });

  it('refreshes an expired Huya source through WUP and uses an alternative host', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('anonymousLogin')) return Response.json({ data: { uid: 900000001 } });
      if (String(url).includes('wup.huya.com')) {
        const bytes = Buffer.from(init?.body as Uint8Array);
        expect(readTars(bytes.subarray(4)).get(6)).toBe('getCdnTokenInfoEx');
        return huyaToken();
      }
      return new Response(huyaPage(0, 1663));
    });
    const adapter = new HuyaAdapter(fetcher);
    const response = await adapter.resolveRecordingSource(huya, '720p', undefined, { previousStreamUrl: 'https://al.flv.huya.com/stream.flv' });
    expect(response).toMatchObject({
      status: 'live', stream: {
        url: expect.stringMatching(/tx\.flv\.huya\.com.*wsSecret=renewed.*ratio=2000/), actualQuality: '720p', format: 'flv',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(signHuyaLine('wsTime=bad', 'stream', '900000001', Date.now())).toBeUndefined();
  });

  it('decodes fragmented Douyu and batched Huya chat, ignoring other message types', () => {
    const payload = Buffer.from('type@=chatmsg/txt@=Hi@S@A/\0');
    const frame = Buffer.alloc(12);
    frame.writeUInt32LE(8 + payload.length, 0);
    frame.writeUInt32LE(8 + payload.length, 4);
    const decode = createDouyuDanmakuDecoder();
    const ready = vi.fn();
    expect(decode(frame.subarray(0, 8), ready)).toEqual([]);
    expect(decode(Buffer.concat([frame.subarray(8), payload]), ready)).toEqual(['Hi/@']);
    const messages = tarsList(1, [
      tarsStruct(0, tarsInt(0, 8006), tarsBytes(1, Buffer.alloc(0))),
      tarsStruct(0, tarsInt(0, 1400), tarsBytes(1, tarsString(3, '虎牙弹幕'))),
    ]);
    expect(decodeHuyaDanmaku(Buffer.concat([tarsInt(0, 22), tarsBytes(1, messages)]), ready)).toEqual(['虎牙弹幕']);
  });

  it('templates cookie validation without using public room access as proof of authorization', async () => {
    expect(normalizeChineseLiveCookie('douyu', 'Cookie: acf_auth=test')).toBe('acf_auth=test');
    expect(() => normalizeChineseLiveCookie('huya', 'yyuid=123\nInjected=header')).toThrow();
    expect(await checkChineseLiveCookie('douyu', 'acf_auth=test', async () =>
      Response.json({ error: 0, data: [] }))).toBe('valid');
    expect(await checkChineseLiveCookie('douyu', 'acf_auth=expired', async () =>
      Response.json({ error: 1, msg: '请登录' }))).toBe('invalid');
    expect(await checkChineseLiveCookie('douyu', 'acf_auth=unconfirmed', async () =>
      new Response('<html>blocked</html>'))).toBe('unknown');
  });
});
