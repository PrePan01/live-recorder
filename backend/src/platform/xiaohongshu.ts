import { AppError, type Quality } from '../types/index.js';
import type { PlatformAdapter, LiveStatusResult, RecordingSourceResult, StreamUrlResult } from './adapter.js';
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from './xiaohongshu-url.js';
import { unknownStatusFallback } from './status-fallback.js';
import { createHash } from 'node:crypto';

export const XHS_UA = 'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A3089/A3090/A3092))';
const PROFILE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const XHS_API = 'https://live-room.xiaohongshu.com';
type Json = Record<string, any>;
export interface XhsSourceStore {
  load(profile: string): string | undefined;
  save(profile: string, url: string): void;
  profileForRoom?(url: string): string | undefined;
  loadProfile?(profile: string): string | undefined;
  saveProfile?(profile: string, url: string): void;
}
export interface XhsRoom { roomId: string; roomUrl: string; hostId: string | null; data: Json; host: Json; live: boolean }
interface ResolveOptions { media?: boolean; identity?: boolean; verifyStatus?: boolean; pinned?: boolean }

/** SSR is JSON plus bare undefined values. Never evaluate remote JavaScript. */
export function parseXhsState(html: string): Json | null {
  const match = /<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script\s*>/i.exec(html);
  if (!match) return null;
  const raw = match[1]!.trim().replace(/;\s*$/, '');
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (raw.startsWith('undefined', i) && !/[\w$]/.test(raw[i - 1] ?? '') && !/[\w$]/.test(raw[i + 9] ?? '')) {
      out += 'null'; i += 8;
    } else out += c;
  }
  try { const value = JSON.parse(out); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

function httpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; }
  catch { return undefined; }
}
function hostIdFromRoom(data: Json): string | null {
  try { const id = new URL(data.deeplink).searchParams.get('host_id'); return id && /^[a-f\d]+$/i.test(id) ? id : null; }
  catch { return null; }
}
export function xhsHttpError(status: number): AppError {
  if ([401, 403, 406, 461, 471].includes(status)) return new AppError('PLATFORM_ACCESS_RESTRICTED', '小红书访问受限，请在设置中登录或重新授权', { retryable: false });
  if (status === 429 || status >= 500) return new AppError('NETWORK_UNAVAILABLE', '小红书暂时繁忙，请稍后重试', { retryable: true });
  if (status === 404 || status === 405) return new AppError('PLATFORM_CHANGED', `小红书请求失败（HTTP ${status}），请更新分享链接或稍后重试`, { retryable: true });
  // 其余 HTTP 码未知：走统一兜底说中性真话（原码透传+学习计数），不凭空断言接口变动。
  return unknownStatusFallback({ httpStatus: status, scope: 'xiaohongshu' });
}

export class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = 'xiaohongshu' as const;
  private memory = new Map<string, string>();
  private profileMemory = new Map<string, string>();
  private busy = false;
  private lanes: Record<'interactive' | 'background', Array<() => void>> = { interactive: [], background: [] };
  private backoffUntil = 0;
  private mediaCache = new Map<string, { room: XhsRoom; until: number }>();
  private mediaPending = new Map<string, Promise<XhsRoom>>();
  private sessionUrls = new Map<string, string>();
  constructor(private fetcher: typeof fetch = fetch, private sources: XhsSourceStore = {
    load: profile => this.memory.get(profile), save: (profile, url) => { this.memory.set(profile, url); },
    loadProfile: profile => this.profileMemory.get(profile), saveProfile: (profile, url) => { this.profileMemory.set(profile, url); },
  }, private nativeRequest?: (url: string, signal?: AbortSignal, cookie?: string) => Promise<{ status: number; text: string }>) {}
  normalizeUrl(raw: string): string { return normalizeXiaohongshuUrl(raw); }
  validateUrl(raw: string): boolean { return parseXiaohongshuUrl(raw) !== null; }

  getRoomPageUrl(raw: string): string | undefined {
    const target = parseXiaohongshuUrl(raw);
    const saved = target?.kind === 'profile' ? this.sources.load(this.normalizeUrl(raw)) : raw;
    return saved && parseXiaohongshuUrl(saved)?.kind === 'room' ? saved : undefined;
  }

  private cacheKey(raw: string, cookie?: string): string {
    return this.normalizeUrl(raw) + '|' + createHash('sha256').update(cookie ?? '').digest('hex');
  }
  private cacheRoom(raw: string, cookie: string | undefined, room: XhsRoom): void {
    const key = this.cacheKey(raw, cookie);
    this.mediaCache.delete(key);
    if (!room.live) return;
    this.mediaCache.set(key, { room, until: Date.now() + 5000 });
    if (this.mediaCache.size > 128) this.mediaCache.delete(this.mediaCache.keys().next().value!);
  }
  /** Video startup never waits behind profile signing or the background detection lane. */
  async resolveMediaRoom(raw: string, cookie?: string, signal?: AbortSignal, fresh = false, sessionId?: string | null): Promise<XhsRoom> {
    signal?.throwIfAborted();
    const key = this.cacheKey(raw, cookie);
    const cached = this.mediaCache.get(key);
    if (!fresh && cached && cached.until > Date.now() && (!sessionId || cached.room.roomId === sessionId)) return cached.room;
    if (!fresh && !signal && this.mediaPending.has(key)) return this.mediaPending.get(key)!;
    const load = async () => {
      if (Date.now() < this.backoffUntil) throw new AppError('NETWORK_UNAVAILABLE', '小红书请求频繁，稍后自动重试', { retryable: true });
      let source = this.getRoomPageUrl(raw);
      if (sessionId) {
        source = this.sessionUrls.get(sessionId) ??
          (source && parseXiaohongshuUrl(source)?.id === sessionId ? source : `https://www.xiaohongshu.com/livestream/${sessionId}`);
      }
      let room = await this.resolveRoom(source ?? raw, cookie, signal, undefined, { media: true, verifyStatus: fresh, pinned: Boolean(sessionId) });
      const target = parseXiaohongshuUrl(raw);
      if (target?.kind === 'profile' && room.hostId && target.id !== room.hostId) throw new AppError('PLATFORM_CHANGED', '小红书返回了其他主播的直播间');
      if (sessionId && room.roomId !== sessionId) throw new AppError('PLATFORM_CHANGED', '小红书返回了其他直播场次');
      // Startup may discover a new broadcast. Recovery stays bound to its original broadcast.
      if (!room.live && !sessionId && !fresh && source) {
        const profile = target?.kind === 'profile' ? raw : this.sources.profileForRoom?.(this.normalizeUrl(raw));
        if (profile) room = await this.resolveRoom(profile, cookie, signal);
      }
      if (!sessionId) this.cacheRoom(raw, cookie, room);
      return room;
    };
    const pending = load();
    if (!fresh && !signal) this.mediaPending.set(key, pending);
    try { return await pending; }
    finally { if (this.mediaPending.get(key) === pending) this.mediaPending.delete(key); }
  }

  private async signedRequest(url: string, cookie: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    const timeout = AbortSignal.timeout(3000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    bounded.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new AppError('NETWORK_UNAVAILABLE', '小红书官网请求超时，请稍后重试', { retryable: true }));
      bounded.addEventListener('abort', abort, { once: true });
      this.nativeRequest!(url, bounded, cookie).then(resolve, reject).finally(() => bounded.removeEventListener('abort', abort));
    });
  }

  private async queued<T>(lane: 'interactive' | 'background', task: () => Promise<T>): Promise<T> {
    if (this.busy) await new Promise<void>(resolve => this.lanes[lane].push(resolve));
    else this.busy = true;
    try {
      if (Date.now() < this.backoffUntil) throw new AppError('NETWORK_UNAVAILABLE', '小红书请求频繁，稍后自动重试', { retryable: true });
      return await task();
    } finally {
      const next = this.lanes.interactive.shift() ?? this.lanes.background.shift();
      if (next) next(); else this.busy = false;
    }
  }

  async request(url: string, cookie?: string, signal?: AbortSignal, userAgent = XHS_UA): Promise<{ text: string; url: string }> {
    const timeout = AbortSignal.timeout(8000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let target = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!['www.xiaohongshu.com', 'xiaohongshu.com', 'xhslink.com', 'live-room.xiaohongshu.com'].includes(target.hostname) ||
          !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.port) {
        throw new AppError('ROOM_LINK_INVALID', '小红书分享链接跳转到了不支持的地址');
      }
      const headers: Record<string, string> = { 'User-Agent': userAgent, Referer: 'https://app.xhs.cn/', 'xy-common-params': 'platform=iOS' };
      if (cookie && target.protocol === 'https:' && target.hostname !== 'xhslink.com') headers.Cookie = cookie;
      let response: Response;
      try { response = await this.fetcher(target.href, { headers, signal: requestSignal, redirect: 'manual' }); }
      catch { throw new AppError('NETWORK_UNAVAILABLE', '无法连接小红书，请检查网络后重试', { retryable: true }); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new AppError('PLATFORM_CHANGED', '小红书返回了无效跳转');
        target = new URL(location, target); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 406].includes(response.status) && cookie && target.hostname === 'live-room.xiaohongshu.com' && this.nativeRequest) {
          const result = await this.nativeRequest(target.href, signal, cookie);
          if (result.status >= 200 && result.status < 300) return { text: result.text, url: target.href };
          throw result.status ? xhsHttpError(result.status) : new AppError('NETWORK_UNAVAILABLE', '小红书官网请求未完成，请稍后重试', { retryable: true });
        }
        if (response.status === 429) this.backoffUntil = Date.now() + 60_000;
        throw xhsHttpError(response.status);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) throw new AppError('PLATFORM_CHANGED', '小红书页面响应过大');
          chunks.push(value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      return { text: Buffer.concat(chunks).toString('utf8'), url: target.href };
    }
    throw new AppError('ROOM_LINK_INVALID', '小红书分享链接跳转次数过多');
  }

  /** Persist the actual broadcast URL; host identity is kept separately in the source store. */
  async resolveRoomUrl(raw: string, cookie?: string): Promise<string> {
    const target = parseXiaohongshuUrl(raw);
    if (!target) throw new AppError('ROOM_LINK_INVALID', '无效的小红书直播或主页链接');
    if (target.kind === 'profile' && target.url.search) this.sources.saveProfile?.(this.normalizeUrl(raw), target.url.href);
    const page = target.kind === 'share' ? await this.request(raw, cookie) : undefined;
    if (page && parseXiaohongshuUrl(page.url)?.kind === 'profile') return this.resolveRoomUrl(page.url, cookie);
    const room = await this.resolveRoom(raw, cookie, undefined, page, { identity: true });
    if (parseXiaohongshuUrl(room.roomUrl)?.kind !== 'room') {
      throw new AppError('ROOM_LINK_INVALID', '该主页暂未提供直播间链接，请在开播后添加直播分享链接');
    }
    const url = this.normalizeUrl(room.roomUrl);
    this.cacheRoom(url, cookie, room);
    return url;
  }

  async resolveRoom(raw: string, cookie?: string, signal?: AbortSignal, preloaded?: { text: string; url: string }, options: ResolveOptions = {}): Promise<XhsRoom> {
    const target = parseXiaohongshuUrl(raw);
    if (!target) throw new AppError('ROOM_LINK_INVALID', '无效的小红书直播或主页链接');
    let page;
    let profileRequestError: unknown;
    const requestUrl = target.kind === 'profile' ? this.sources.loadProfile?.(this.normalizeUrl(raw)) ?? target.url.href : target.url.href;
    try { page = preloaded ?? await this.request(requestUrl, cookie, signal, target.kind === 'profile' ? PROFILE_UA : XHS_UA); }
    catch (error) {
      if (target.kind !== 'profile' || !this.sources.load(this.normalizeUrl(raw)) || signal?.aborted) throw error;
      // A profile-page failure must not block a still-accessible saved room share.
      profileRequestError = error;
      page = { text: '', url: target.url.href };
    }
    if (target.kind === 'share' && parseXiaohongshuUrl(page.url)?.kind === 'profile') return this.resolveRoom(page.url, cookie, signal, page, options);
    let state = parseXhsState(page.text);
    let usingPreviousRoom = false;
    if (target.kind === 'profile') {
      // Some profile versions expose a live link in SSR/markup. Preserve the actual URL and its token.
      const urls: string[] = [];
      const pending: unknown[] = state ? [state] : [];
      // The official PC profile avatar opens basicInfo.live.roomId with xsecToken.
      // Mobile profile SSR can omit this entire object, even for an active host.
      let profileLive = state?.user?.userPageData?.basicInfo?.live;
      if (!profileLive && cookie && this.nativeRequest) {
        try {
          const params = new URLSearchParams({ target_user_id: target.id! });
          const profileUrl = new URL(requestUrl);
          for (const key of ['xsec_token', 'xsec_source']) {
            const value = profileUrl.searchParams.get(key); if (value) params.set(key, value);
          }
          // The official avatar hover card exposes live metadata even when otherinfo omits it.
          for (const endpoint of ['hover_card', 'otherinfo']) {
            const query = new URLSearchParams(params);
            if (endpoint === 'hover_card') {
              query.set('image_formats', 'jpg,webp,avif');
            }
            const response = await this.signedRequest(`https://edith.xiaohongshu.com/api/sns/web/v1/user/${endpoint}?${query}`, cookie, signal);
            const json = response.status === 200 ? JSON.parse(response.text) : null;
            const basic = json?.data?.basic_info ?? json?.data?.basicInfo;
            if (json?.success === true && basic?.live) {
              const live = basic.live;
              profileLive = { liveStatus: live.liveStatus ?? live.live_status, roomId: live.roomId ?? live.room_id, xsecToken: live.xsecToken ?? live.xsec_token };
              state = { ...state, user: { userPageData: { basicInfo: { ...basic, live: profileLive } } } };
              break;
            }
          }
        } catch { /* Keep a valid saved room usable when native signing is unavailable. */ }
      }
      if (profileLive && [0, 1, 3].includes(profileLive.liveStatus)) {
        const basic = state!.user.userPageData.basicInfo;
        return { roomId: String(profileLive.roomId ?? '0'), roomUrl: target.url.href, hostId: target.id,
          data: {}, host: { nickName: basic.nickname, avatar: basic.imageb }, live: false };
      }
      if (profileLive?.liveStatus === 2 && /^\d+$/.test(String(profileLive.roomId))) {
        const current = new URL(`https://www.xiaohongshu.com/livestream/${profileLive.roomId}`);
        if (typeof profileLive.xsecToken === 'string' && profileLive.xsecToken) current.searchParams.set('xsec_token', profileLive.xsecToken);
        urls.push(current.href);
      }
      while (pending.length) {
        const item = pending.pop();
        if (typeof item === 'string' && parseXiaohongshuUrl(item)?.kind === 'room') urls.push(item);
        else if (item && typeof item === 'object') pending.push(...Object.values(item));
      }
      for (const match of page.text.matchAll(/https?:\/\/(?:www\.)?xiaohongshu\.com\/livestream\/[\d]+[^\s"<>]*/g)) urls.push(match[0].replace(/&amp;/g, '&'));
      const source = urls[0] ?? this.sources.load(this.normalizeUrl(raw));
      if (!source) throw new AppError('PLATFORM_ACCESS_RESTRICTED', '暂未从小红书主页获取到直播间，请添加该主播的直播分享链接以关联录制', { retryable: true });
      usingPreviousRoom = urls.length === 0;
      page = await this.request(source, cookie, signal); state = parseXhsState(page.text);
    }
    if (!state?.liveStream) throw new AppError('PLATFORM_CHANGED', '未获取到小红书直播数据，请检查授权或更新分享链接', { retryable: true });
    const section = state.liveStream;
    const data = section.roomData?.roomInfo ?? {};
    const roomId = String(data.roomId ?? parseXiaohongshuUrl(page.url)?.id ?? '');
    if (!/^\d+$/.test(roomId)) throw new AppError('PLATFORM_CHANGED', '小红书未返回有效直播间标识');
    const hostId = hostIdFromRoom(data);
    if (target.kind === 'profile' && hostId && hostId !== target.id) throw new AppError('PLATFORM_CHANGED', '小红书返回了其他主播的直播间');
    if (data.status === 2 && cookie && this.nativeRequest && !options.identity && (!options.media || options.verifyStatus)) {
      try {
        const params = new URLSearchParams({ room_id: roomId, scene: 'share_out_of_app' });
        const response = await this.signedRequest(`${XHS_API}/api/sns/red/live/h5/v1/core/current_live_status?${params}`, cookie, signal);
        const json = response.status === 200 ? JSON.parse(response.text) : null;
        if (json?.success === true && [2, 3].includes(json.data?.status)) data.status = json.data.status;
      } catch { /* An unavailable status API is not proof that an accessible media stream ended. */ }
    }
    const live = section.liveStatus === 'success' && data.status === 2;
    // An ended saved broadcast is offline when the accessible profile offers no new
    // room. Keep polling the profile on later checks to discover the next broadcast.
    // A failed profile request still cannot establish the host's current status.
    if (usingPreviousRoom && !options.media && !live && profileRequestError) throw profileRequestError;
    if (!live && section.liveStatus !== 'end' && data.status !== 3) {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '小红书直播状态暂不可确认，请检查授权或更新分享链接', { retryable: true });
    }
    const room = { roomId, roomUrl: page.url, hostId, data, host: section.roomData?.hostInfo ?? {}, live };
    if (hostId) {
      const profile = `https://www.xiaohongshu.com/user/profile/${hostId}`;
      this.sessionUrls.set(roomId, page.url);
      if (this.sessionUrls.size > 256) this.sessionUrls.delete(this.sessionUrls.keys().next().value!);
      const saved = this.sources.load(profile);
      if (!options.pinned && (target.kind === 'profile' || options.identity || !saved || parseXiaohongshuUrl(saved)?.id === roomId)) {
        this.sources.save(profile, this.normalizeUrl(page.url));
      }
    }
    return room;
  }

  streams(room: XhsRoom): Array<StreamUrlResult> {
    let config = room.data.pullConfig;
    try { if (typeof config === 'string') config = JSON.parse(config); } catch { return []; }
    const streams: StreamUrlResult[] = [];
    for (const entry of Array.isArray(config?.h264) ? config.h264 : []) {
      const raw = httpUrl(entry?.master_url); if (!raw) continue;
      const u = new URL(raw);
      if (!u.hostname.endsWith('.xhscdn.com')) continue;
      const format = u.pathname.endsWith('.flv') ? 'flv' : u.pathname.endsWith('.m3u8') ? 'hls' : null;
      if (!format) continue;
      // Dimensions determine the reported resolution. HD is an opaque platform label.
      const height = Number(entry.height ?? config.height);
      if (!Number.isFinite(height) || height <= 0) continue;
      const quality: Quality = height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 540 ? '540p' : '360p';
      streams.push({ url: raw, format, actualQuality: quality, streamSessionId: room.roomId, headers: { 'User-Agent': XHS_UA, Referer: 'https://app.xhs.cn/' } });
    }
    return streams.sort((a, b) => (a.format === 'flv' ? 0 : 1) - (b.format === 'flv' ? 0 : 1));
  }
  private select(room: XhsRoom, quality: Quality): StreamUrlResult {
    const streams = this.streams(room);
    const rank: Record<Quality, number> = { original: 5, '1080p': 4, '720p': 3, '540p': 2, '360p': 1 };
    const sorted = [...streams].sort((a, b) => rank[b.actualQuality] - rank[a.actualQuality]);
    const picked = sorted.find(stream => rank[stream.actualQuality] <= rank[quality]) ?? sorted.at(-1);
    if (!picked) throw new AppError('PLATFORM_CHANGED', '小红书尚未提供可录制的 H.264 直播流', { retryable: true });
    return picked;
  }
  async checkLiveStatus(raw: string, cookie?: string): Promise<LiveStatusResult> {
    try {
      const room = await this.queued('background', async () => {
        const previous = await this.resolveRoom(raw, cookie);
        // Only discover another broadcast after the saved broadcast has ended.
        const profile = !previous.live ? this.sources.profileForRoom?.(this.normalizeUrl(raw)) : undefined;
        return profile ? this.resolveRoom(profile, cookie) : previous;
      });
      this.cacheRoom(raw, cookie, room);
      const displayName = typeof room.host.nickName === 'string' ? room.host.nickName : undefined;
      return { status: room.live ? 'live' : 'offline', streamSessionId: room.roomId,
        ...(displayName ? { displayName } : {}),
        ...(httpUrl(room.host.avatar) ? { avatarUrl: httpUrl(room.host.avatar)! } : {}),
        ...(typeof room.data.roomTitle === 'string' ? { streamTitle: room.data.roomTitle } : {}),
        ...(httpUrl(room.data.roomCover) ? { liveCoverUrl: httpUrl(room.data.roomCover)! } : {}),
        availableQualities: room.live ? [...new Set(this.streams(room).map(stream => stream.actualQuality))] : [],
      };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('NETWORK_UNAVAILABLE', '小红书检测失败，请稍后重试', { retryable: true });
      return { status: appError.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: appError.toObject() };
    }
  }
  async checkLiveStatusForStartup(raw: string, cookie?: string): Promise<LiveStatusResult> {
    try {
      const room = await this.resolveMediaRoom(raw, cookie);
      return { status: room.live ? 'live' : 'offline', streamSessionId: room.roomId,
        ...(typeof room.data.roomTitle === 'string' ? { streamTitle: room.data.roomTitle } : {}) };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('NETWORK_UNAVAILABLE', '小红书检测失败', { retryable: true });
      return { status: appError.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: appError.toObject() };
    }
  }
  async resolveRecordingSource(raw: string, quality: Quality, cookie?: string, context?: { streamSessionId?: string | null }): Promise<RecordingSourceResult> {
    try {
      const room = await this.resolveMediaRoom(raw, cookie, undefined, true, context?.streamSessionId);
      return room.live ? { status: 'live', stream: this.select(room, quality) } : { status: 'offline' };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('NETWORK_UNAVAILABLE', '小红书取流失败', { retryable: true });
      return { status: appError.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: appError.toObject() };
    }
  }
  async getStreamUrl(raw: string, quality: Quality, cookie?: string): Promise<StreamUrlResult> {
    const room = await this.resolveMediaRoom(raw, cookie);
    if (room.live) return this.select(room, quality);
    throw new AppError('RECORDING_START_FAILED', '小红书直播已结束');
  }
}
