import type { Quality, StreamUrlResult } from '../adapter.js';
import { chooseQuality, HttpLiveAdapter, md5Hex, object, protocolChanged, responseJson, responseText, sameSiteHeaders, webRequest } from '../chinese-live/adapter.js';
import { chineseRoomUrl, numericRoomId, parseChineseRoomLink } from '../chinese-live/url.js';
import { AppError } from '../../types/error.js';
import { parseHuyaRoom, type HuyaLine, type HuyaRoom } from './room.js';
import { fetchHuyaCdnToken } from './wup.js';

function query(antiCode: string): URLSearchParams {
  return new URLSearchParams(antiCode.replace(/&amp;/gi, '&'));
}

export function signHuyaLine(antiCode: string, stream: string, uid: string, now: number): URLSearchParams | undefined {
  const params = query(antiCode);
  const stamp = params.get('wsTime') ?? '';
  const expiration = /^[a-f\d]{1,12}$/i.test(stamp) ? parseInt(stamp, 16) * 1000 : 0;
  if (expiration < now + 5_000) return;
  const fm = params.get('fm');
  if (!fm) return params.get('wsSecret') ? params : undefined;
  const template = Buffer.from(fm.replace(/ /g, '+'), 'base64').toString('utf8');
  if (!['$0', '$1', '$2', '$3'].every(label => template.includes(label))) return;
  const ctype = params.get('ctype') ?? 'huya_live';
  const platform = ctype === 'huya_live' || ctype === 'huya_webh5' ? 100 : Number(params.get('t')) || 100;
  const uint = BigInt(uid) & 0xffffffffn;
  const viewer = ((uint << 8n) | (uint >> 24n)) & 0xffffffffn;
  const seqid = (BigInt(uid) + BigInt(now)).toString();
  const digest = md5Hex(`${seqid}|${ctype}|${platform}`);
  const replacements = [viewer.toString(), stream, digest, stamp];
  params.set('wsSecret', md5Hex(template.replace(/\$([0-3])/g, (_, index: string) => replacements[Number(index)]!)));
  params.set('seqid', seqid);
  params.set('ctype', ctype);
  params.set('u', viewer.toString());
  params.set('t', String(platform));
  params.set('ver', '1');
  params.set('sdk_sid', String(now));
  if (!params.has('sv')) params.set('sv', '2401090219');
  params.delete('fm');
  return params;
}

export class HuyaAdapter extends HttpLiveAdapter<'huya', HuyaRoom> {
  readonly platform = 'huya' as const;
  private guest?: { uid: string; expiresAt: number };
  private guestRequest: Promise<string> | undefined;

  constructor(private readonly fetcher: typeof fetch = fetch) { super(); }

  protected async fetchRoom(room: string, cookie?: string): Promise<HuyaRoom> {
    const headers = sameSiteHeaders(this.platform, room, cookie);
    let response = await webRequest(this.fetcher, '虎牙直播间', chineseRoomUrl(this.platform, room), { headers });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      const target = location && parseChineseRoomLink(this.platform, new URL(location, 'https://www.huya.com').href);
      if (!target || target === room) throw protocolChanged('虎牙直播间跳转');
      response = await webRequest(this.fetcher, '虎牙直播间', chineseRoomUrl(this.platform, target), { headers });
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('ROOM_LINK_INVALID', '虎牙直播间不存在');
    }
    return parseHuyaRoom(await responseText(response, '虎牙直播间'));
  }

  async getDanmakuUid(raw: string, cookie?: string): Promise<string> {
    const room = await this.roomSnapshot(this.roomFromUrl(raw), cookie);
    if (!room.uid) throw protocolChanged('虎牙弹幕房间');
    return room.uid;
  }

  protected async fetchStream(room: HuyaRoom, quality: Quality, cookie: string | undefined, avoid?: string): Promise<StreamUrlResult> {
    const selected = chooseQuality(room.rates, quality);
    if (!selected || !room.lines.length) throw protocolChanged('虎牙播放档位');
    const lines = [...room.lines].sort((a, b) =>
      Number(a.base.hostname === avoid) - Number(b.base.hostname === avoid) ||
      Number(a.format !== 'flv') - Number(b.format !== 'flv') || b.priority - a.priority);
    const accountUid = numericRoomId(/(?:^|;\s*)yyuid=(\d+)(?:;|$)/.exec(cookie ?? '')?.[1]);
    const uid = accountUid ?? await this.anonymousUid();
    let lastFailure: unknown;
    for (const line of lines.slice(0, 4)) {
      try {
        const now = Date.now();
        const forceRefresh = line.format === 'flv' && (room.category === 1663 || room.category === 1 || Boolean(avoid));
        const params = await this.playbackParams(room, line, uid, accountUid ? cookie : undefined, now, forceRefresh);
        if (selected.ratio) params.set('ratio', String(selected.ratio));
        else params.delete('ratio');
        params.set('codec', '264');
        const url = new URL(line.base.href);
        url.pathname = `${url.pathname.replace(/\/$/, '')}/${line.name}.${line.suffix}`;
        url.search = params.toString();
        return {
          url: url.href, format: line.format, actualQuality: selected.quality,
          ...(room.live.streamSessionId ? { streamSessionId: room.live.streamSessionId } : {}),
          headers: sameSiteHeaders(this.platform, room.id),
        };
      } catch (error) {
        lastFailure = error;
      }
    }
    throw lastFailure ?? protocolChanged('虎牙播放');
  }

  private async playbackParams(room: HuyaRoom, line: HuyaLine, uid: string, cookie: string | undefined, now: number, refresh: boolean): Promise<URLSearchParams> {
    const signed = signHuyaLine(line.antiCode, line.name, uid, now);
    if (signed && !refresh) return signed;
    if (line.format === 'flv') {
      try {
        const token = await fetchHuyaCdnToken(this.fetcher, room.id, line.base.href, line.name, uid, cookie);
        const refreshed = signHuyaLine(token, line.name, uid, Date.now());
        if (refreshed) return refreshed;
      } catch (error) {
        if (!signed) throw error;
      }
    }
    if (signed) return signed;
    throw new AppError('STREAM_URL_EXPIRED', '虎牙播放签名已失效', { retryable: true });
  }

  private async anonymousUid(): Promise<string> {
    if (this.guest && this.guest.expiresAt > Date.now()) return this.guest.uid;
    this.guestRequest ??= this.fetchGuest().finally(() => { this.guestRequest = undefined; });
    return this.guestRequest;
  }

  private async fetchGuest(): Promise<string> {
    const response = await webRequest(this.fetcher, '虎牙匿名会话', 'https://udblgn.huya.com/web/anonymousLogin', {
      method: 'POST',
      headers: { ...sameSiteHeaders(this.platform, ''), 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 5002, byPass: 3, context: '', version: '2.4', data: {} }),
    });
    const payload = await responseJson(response, '虎牙匿名会话');
    const uid = numericRoomId(object(payload.data)?.uid);
    if (!uid) throw protocolChanged('虎牙匿名会话');
    this.guest = { uid, expiresAt: Date.now() + 30 * 60_000 };
    return uid;
  }
}
