import { createHash, randomBytes } from 'node:crypto';
import type { Quality, StreamUrlResult } from '../adapter.js';
import {
  boundedSet, chooseQuality, HttpLiveAdapter, httpsUrl, list, md5Hex, number, object, protocolChanged,
  qualityFromLabel, responseJson, responseText, sameSiteHeaders, streamStartedAt, string, webRequest,
  type RoomSnapshot,
} from '../chinese-live/adapter.js';
import { chineseRoomUrl, numericRoomId } from '../chinese-live/url.js';
import { AppError } from '../../types/error.js';

const HOST = 'https://www.douyu.com';
const CDN_DOMAINS = ['douyucdn.cn', 'douyucdn2.cn', 'douyucdn.com', 'douyutv.com', 'douyu.com'];
type Rate = { id: number; quality: Quality };
type DouyuRoom = RoomSnapshot & { rates: Rate[] | undefined; lines: string[] | undefined; playbackKey: string };

export function douyuAuth(room: string, time: number, key: string, salt: string, rounds: number, special: boolean): string {
  let digest = salt;
  for (let i = 0; i < rounds; i++) digest = md5Hex(digest + key);
  return md5Hex(digest + key + (special ? '' : `${room}${time}`));
}

function ratesFromPlay(data: Record<string, unknown>): Rate[] {
  return list(data.multirates).flatMap(value => {
    const rate = object(value);
    const id = number(rate?.rate);
    const name = string(rate?.name);
    const quality = id === 0 || /原画|^source$/i.test(name ?? '') ? 'original' : qualityFromLabel(name, rate?.height);
    return id !== undefined && id >= 0 && quality ? [{ id, quality }] : [];
  });
}

function playbackUrl(data: Record<string, unknown>): URL | undefined {
  const host = httpsUrl(data.rtmp_url, CDN_DOMAINS);
  const resource = string(data.rtmp_live);
  if (!host || !resource || !/^[\w.-]+\.flv(?:\?|$)/i.test(resource)) return;
  return httpsUrl(`${host.href.replace(/\/$/, '')}/${resource}`, CDN_DOMAINS);
}

export class DouyuAdapter extends HttpLiveAdapter<'douyu', DouyuRoom> {
  readonly platform = 'douyu' as const;
  private readonly did = randomBytes(16).toString('hex');
  private readonly cdnHosts = new Map<string, string>();
  private readonly playback = new Map<string, { rates: Rate[]; lines: string[]; session: string | undefined; expiresAt: number }>();

  constructor(private readonly fetcher: typeof fetch = fetch) { super(); }

  protected async fetchRoom(room: string, cookie?: string): Promise<DouyuRoom> {
    const headers = sameSiteHeaders(this.platform, room, cookie);
    const numeric = numericRoomId(room);
    let data = numeric ? await this.fetchBetard(numeric, headers) : null;
    if (data === null) {
      const resolved = await this.resolveRoomPageId(room, headers);
      if (resolved && resolved !== numeric) data = await this.fetchBetard(resolved, headers);
      if (data === null) throw new AppError('ROOM_LINK_INVALID', '斗鱼直播间不存在');
    }
    const canonical = numericRoomId(data.room_id);
    const status = number(data.show_status);
    if (!canonical || (status !== 1 && status !== 2)) throw protocolChanged('斗鱼直播间');
    const started = streamStartedAt(data.show_time ?? data.live_start_time);
    const show = numericRoomId(data.show_id);
    const session = show ?? (started ? `${canonical}:${started}` : undefined);
    const playbackKey = `${canonical}:${cookie ? createHash('sha256').update(cookie).digest('hex') : ''}`;
    const prior = this.playback.get(playbackKey);
    const known = status === 1 && prior && prior.expiresAt > Date.now() && prior.session === session ? prior : undefined;
    const hintedRates = list(data.multirates).flatMap(value => {
      const rate = object(value);
      const id = number(rate?.type);
      const quality = id === 0 ? 'original' : qualityFromLabel(rate?.name);
      return id !== undefined && id >= 0 && quality ? [{ id, quality }] : [];
    });
    if (status === 2) this.playback.delete(playbackKey);
    const displayName = string(data.nickname);
    const streamTitle = string(data.room_name);
    const avatarUrl = [data.avatar_big, data.owner_avatar, data.avatar].map(value => httpsUrl(value, CDN_DOMAINS)).find(Boolean)?.href;
    const liveCoverUrl = [data.room_src, data.room_pic, data.show_pic, data.coverSrc, data.defaultSrc]
      .map(value => httpsUrl(value, CDN_DOMAINS)).find(Boolean)?.href;
    const restricted = status === 1 && number(data.room_pass ?? data.is_password) === 1;
    return {
      id: canonical,
      playbackKey,
      rates: known?.rates ?? hintedRates,
      lines: known?.lines,
      live: {
        status: restricted ? 'restricted' : status === 1 ? 'live' : 'offline',
        ...(restricted ? { error: new AppError('PLATFORM_ACCESS_RESTRICTED', '斗鱼直播间访问受限').toObject() } : {}),
        ...(status === 1 && session ? { streamSessionId: session } : {}),
        ...(status === 1 && started ? { platformStartedAt: started } : {}),
        ...(displayName ? { displayName } : {}),
        ...(streamTitle ? { streamTitle } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(liveCoverUrl ? { liveCoverUrl } : {}),
        ...(known?.rates.length ? { availableQualities: [...new Set(known.rates.map(rate => rate.quality))] } : {}),
      },
    };
  }

  private async fetchBetard(id: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
    const response = await webRequest(this.fetcher, '斗鱼直播间', `${HOST}/betard/${id}`, { headers });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await responseText(response, '斗鱼直播间');
    // The legacy API also serves this HTML response for numeric aliases.
    if (/^\s*<!doctype html\b/i.test(body) && body.includes('您观看的房间已被关闭')) return null;
    try {
      const data = object(object(JSON.parse(body))?.room);
      if (data) return data;
    } catch { /* Unexpected upstream response. */ }
    throw protocolChanged('斗鱼直播间');
  }

  private async resolveRoomPageId(room: string, headers: Record<string, string>): Promise<string | undefined> {
    const page = await webRequest(this.fetcher, '斗鱼直播间', chineseRoomUrl(this.platform, room), { headers });
    if (page.status === 404 || (page.status >= 300 && page.status < 400)) {
      await page.body?.cancel().catch(() => undefined);
      const location = page.headers.get('location');
      const target = location ? httpsUrl(URL.parse(location, HOST)?.href, ['douyu.com']) : undefined;
      return target ? numericRoomId(target.pathname.replace(/^\/|\/$/g, '')) : undefined;
    }
    const html = await responseText(page, '斗鱼直播间');
    const current = /\\?"roomInfo\\?"\s*:\s*\{\s*\\?"room\\?"\s*:\s*\{\s*\\?"room_id\\?"\s*:\s*(\d+)/.exec(html);
    const legacy = current ?? /(?:(?:\$ROOM|window)\.room_id\s*=\s*|["']room_id["']\s*:\s*["']?)(\d+)/.exec(html);
    return numericRoomId(legacy?.[1]);
  }

  protected async fetchStream(room: DouyuRoom, quality: Quality, cookie: string | undefined, avoid?: string): Promise<StreamUrlResult> {
    const headers = sameSiteHeaders(this.platform, room.id, cookie);
    const did = /(?:^|;\s*)(?:dy_did|acf_did)=([a-f\d]{32})(?:;|$)/i.exec(cookie ?? '')?.[1] ?? this.did;
    const line = avoid ? room.lines?.find(cdn => {
      const known = this.cdnHosts.get(cdn);
      return known ? known !== avoid : !avoid.startsWith(cdn.split('-')[0]!);
    }) : undefined;
    const initial = chooseQuality(room.rates ?? [], quality)?.id ?? 0;
    let data = await this.play(room.id, initial, line ?? '', did, headers);
    let rates = ratesFromPlay(data);
    const selected = chooseQuality(rates, quality);
    const actual = number(data.rate);
    const lines = list(data.cdnsWithName ?? data.cdns).flatMap(value => {
      const cdn = string(object(value)?.cdn ?? value);
      return cdn && /^[\w-]{1,32}$/.test(cdn) ? [cdn] : [];
    });
    const previousLine = string(data.selected_cdn ?? data.rtmp_cdn ?? data.cdn);
    const alternate = avoid && playbackUrl(data)?.hostname === avoid
      ? lines.find(cdn => cdn !== previousLine && cdn !== line) : undefined;
    if ((selected && selected.id !== initial && selected.id !== actual) || alternate) {
      try {
        data = await this.play(room.id, selected?.id ?? initial, alternate ?? line ?? '', did, headers);
        const updatedRates = ratesFromPlay(data);
        if (updatedRates.length) rates = updatedRates;
      } catch (error) {
        if (!playbackUrl(data)) throw error;
      }
    }
    const url = playbackUrl(data);
    if (!url) throw protocolChanged('斗鱼播放');
    const returnedRate = number(data.rate);
    const cdn = string(data.selected_cdn ?? data.rtmp_cdn ?? data.cdn);
    if (cdn) boundedSet(this.cdnHosts, cdn, url.hostname);
    const actualQuality = rates.find(rate => rate.id === returnedRate)?.quality ??
      qualityFromLabel(data.rateName, data.height) ?? (returnedRate === 0 || (returnedRate === undefined && rates.length === 0) ? 'original' : undefined);
    if (!actualQuality) throw protocolChanged('斗鱼播放画质');
    if (!rates.length) rates = returnedRate === undefined ? [] : [{ id: returnedRate, quality: actualQuality }];
    room.rates = rates;
    room.lines = lines;
    room.live.availableQualities = [...new Set(rates.map(rate => rate.quality))];
    boundedSet(this.playback, room.playbackKey, { rates, lines, session: room.live.streamSessionId, expiresAt: Date.now() + 120_000 });
    return {
      url: url.href, format: 'flv', actualQuality,
      ...(room.live.streamSessionId ? { streamSessionId: room.live.streamSessionId } : {}),
      headers: { ...sameSiteHeaders(this.platform, room.id), Cookie: `dy_did=${did}` },
    };
  }

  private async play(room: string, rate: number, cdn: string, did: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const encrypt = await webRequest(this.fetcher, '斗鱼播放签名', `${HOST}/wgapi/livenc/liveweb/websec/getEncryption?did=${did}`, { headers });
      const serverTime = Date.parse(encrypt.headers.get('date') ?? '');
      const time = Math.floor((Number.isFinite(serverTime) ? serverTime : Date.now()) / 1000);
      const encryption = await responseJson(encrypt, '斗鱼播放签名');
      const descriptor = object(encryption.data);
      const key = string(descriptor?.key);
      const salt = string(descriptor?.rand_str);
      const encrypted = string(descriptor?.enc_data);
      const rounds = number(descriptor?.enc_time);
      if (number(encryption.error) !== 0 || !key || !salt || !encrypted || rounds === undefined || rounds < 0 || rounds > 10_000) {
        throw protocolChanged('斗鱼播放签名');
      }
      const body = new URLSearchParams({
        enc_data: encrypted, tt: String(time), did, auth: douyuAuth(room, time, key, salt, rounds, number(descriptor?.is_special) === 1),
        cdn, rate: String(rate), hevc: '0', fa: '0', ive: '0',
      });
      const response = await webRequest(this.fetcher, '斗鱼播放', `${HOST}/lapi/live/getH5PlayV1/${room}`, {
        method: 'POST',
        headers: { ...headers, Cookie: [headers.Cookie, `dy_did=${did}`].filter(Boolean).join('; ') },
        body,
      });
      const result = await responseJson(response, '斗鱼播放');
      const data = object(result.data);
      if (number(result.error) === 0 && data && playbackUrl(data)) return data;
      if (/未登录|登录后|密码|付费|无权限/.test(string(result.msg ?? result.message) ?? '')) {
        throw new AppError('PLATFORM_ACCESS_RESTRICTED', '斗鱼播放访问受限，请检查授权');
      }
    }
    throw new AppError('PLATFORM_SERVER_ERROR', '斗鱼暂未返回可用播放线路', { retryable: true });
  }
}
