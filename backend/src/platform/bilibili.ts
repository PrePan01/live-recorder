import { AppError } from '../types/error.js';
import type { ErrorObject, Quality } from '../types/index.js';
import type { LiveStatusResult, PlatformAdapter, StreamUrlResult } from './adapter.js';

/** 目标清晰度 → B站 qn（原画 10000 / 蓝光 400 / 高清 150 / 流畅 80）。 */
const BILI_QN: Record<Quality, number> = { original: 10000, '1080p': 400, '720p': 150, '360p': 80 };

/** B站 qn → 本地清晰度（实际可用档位回报用）。 */
function qnToQuality(qn: number): Quality {
  if (qn >= 10000) return 'original';
  if (qn >= 400) return '1080p';
  if (qn >= 150) return '720p';
  return '360p';
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PLATFORM_REQUEST_TIMEOUT_MS = 8_000;

interface BiliUrlInfo {
  host?: string;
  base_url?: string;
  extra?: string;
}

interface BiliCodec {
  codec_name?: string;
  current_qn?: number;
  accept_qn?: number[];
  base_url?: string;
  url_info?: BiliUrlInfo[];
}

interface BiliPlayResponse {
  code?: number;
  data?: {
    live_status?: number;
    live_time?: number;
    room_info?: { title?: string };
    anchor_info?: { base_info?: { uname?: string } };
    playurl_info?: {
      playurl?: {
        stream?: Array<{
          protocol_name?: string;
          format?: Array<{ format_name?: string; codec?: BiliCodec[] }>;
        }>;
      };
    };
  };
}

/** getRoomPlayInfo 已不再返回 room_info/anchor_info，改用以下两个免 Cookie 端点补充名称信息。 */
interface BiliAnchorResponse {
  code?: number;
  data?: { info?: { uname?: string } };
}

interface BiliRoomInfoResponse {
  code?: number;
  data?: { title?: string; uid?: number };
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || 'cause' in err));
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly platform = 'bilibili' as const;

  constructor(
    private fetcher: typeof fetch = fetch,
    private apiBase = 'https://api.live.bilibili.com',
    private roomBase = 'https://live.bilibili.com',
  ) {}

  normalizeUrl(raw: string): string {
    return raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  validateUrl(raw: string): boolean {
    return /^https?:\/\/(live\.bilibili\.com|m\.live\.bilibili\.com|bilibili\.com)\/\d+/.test(raw.trim());
  }

  parseRoomId(roomUrl: string): number | null {
    const m = /^https?:\/\/(?:live\.bilibili\.com|m\.live\.bilibili\.com|bilibili\.com)\/(\d+)/.exec(this.normalizeUrl(roomUrl));
    return m ? Number(m[1]) : null;
  }

  private async fetchPlayInfo(roomId: number, cookie?: string, qn?: number): Promise<BiliPlayResponse> {
    const params = new URLSearchParams({
      room_id: String(roomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      qn: String(qn ?? BILI_QN.original),
      platform: 'web',
      ptype: '8',
    });
    const res = await this.fetcher(`${this.apiBase}/xlive/web-room/v2/index/getRoomPlayInfo?${params}`, {
      signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': UA,
        Referer: `${this.roomBase}/${roomId}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) throw new Error(`bilibili api http ${res.status}`);
    return (await res.json()) as BiliPlayResponse;
  }

  /** getRoomPlayInfo 响应已不含主播名/标题；用 get_anchor_in_room 取昵称、get_info 取标题，均免 Cookie 且无风控。 */
  private async fetchRoomMeta(roomId: number): Promise<{ uname?: string; title?: string }> {
    const headers = {
      'User-Agent': UA,
      Referer: `${this.roomBase}/${roomId}`,
    };
    const [anchor, info] = await Promise.all([
      this.fetcher(`${this.apiBase}/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`, {
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        headers,
      }).then(async (r) => (r.ok ? ((await r.json()) as BiliAnchorResponse) : null)).catch(() => null),
      this.fetcher(`${this.apiBase}/room/v1/Room/get_info?room_id=${roomId}`, {
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        headers,
      }).then(async (r) => (r.ok ? ((await r.json()) as BiliRoomInfoResponse) : null)).catch(() => null),
    ]);
    const uname = anchor?.code === 0 ? anchor.data?.info?.uname : undefined;
    const title = info?.code === 0 ? info.data?.title : undefined;
    return { ...(uname ? { uname } : {}), ...(title ? { title } : {}) };
  }

  /** 取流：优先 http_stream/flv + avc；在全部可用 codec 中选择最接近目标档位的流。
   *  #xxx 修复：不再只取首个有 URL 的 codec（常为最高档/原画）——选择 actualQn ≤ target 的最高档，
   *  若无可选（目标档不可用）则取最低可用档，保证「选 360p/720p 不会录成原画」。 */
  private pickStream(data: BiliPlayResponse, targetQn: number): { url: string; format: 'flv' | 'hls'; actualQn: number } | null {
    const streams = data.data?.playurl_info?.playurl?.stream ?? [];
    const ordered = [...streams].sort((a, b) => rankProtocol(a.protocol_name) - rankProtocol(b.protocol_name));
    let best: { url: string; format: 'flv' | 'hls'; actualQn: number } | null = null;
    for (const stream of ordered) {
      const formats = [...(stream.format ?? [])].sort((a, b) => rankFormat(a.format_name) - rankFormat(b.format_name));
      for (const fmt of formats) {
        const codecs = [...(fmt.codec ?? [])].sort((a, b) => rankCodec(a.codec_name) - rankCodec(b.codec_name));
        for (const codec of codecs) {
          const current = codec.current_qn ?? 0;
          const acceptable = codec.accept_qn ?? [current];
          const picked = pickQn(acceptable, targetQn);
          const info = codec.url_info?.[0];
          if (!info?.host || !codec.base_url) continue;
          const isFlv = fmt.format_name === 'flv' || codec.base_url.includes('.flv');
          const candidate: { url: string; format: 'flv' | 'hls'; actualQn: number } = {
            url: `${info.host}${codec.base_url}${info.extra ?? ''}`,
            format: isFlv ? 'flv' : 'hls',
            actualQn: picked || current,
          };
          if (!best || betterQnMatch(candidate.actualQn, best.actualQn, targetQn)) best = candidate;
        }
      }
    }
    return best;
  }

  private availableQns(data: BiliPlayResponse): number[] {
    const set = new Set<number>();
    for (const stream of data.data?.playurl_info?.playurl?.stream ?? []) {
      for (const fmt of stream.format ?? []) {
        for (const codec of fmt.codec ?? []) {
          for (const qn of codec.accept_qn ?? []) set.add(qn);
          if (codec.current_qn) set.add(codec.current_qn);
        }
      }
    }
    return [...set].sort((a, b) => b - a);
  }

  async checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) {
      return { status: 'error', error: new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {}).toObject() };
    }
    let data: BiliPlayResponse;
    try {
      data = await this.fetchPlayInfo(roomId, cookie);
    } catch (err) {
      return { status: 'error', error: (isNetworkError(err) ? new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true }) : new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {})).toObject() };
    }
    if (data.code !== 0 || !data.data) {
      return { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {}).toObject() };
    }
    // getRoomPlayInfo 已不再返回 room_info/anchor_info，名称信息改由 get_anchor_in_room/get_info 补充。
    const meta = await this.fetchRoomMeta(roomId);
    const title = data.data.room_info?.title ?? meta.title ?? '';
    const uname = data.data.anchor_info?.base_info?.uname ?? meta.uname;
    if (data.data.live_status !== 1) {
      return { status: 'offline', ...(uname ? { displayName: uname } : {}) };
    }
    const hasStream = Boolean(data.data.playurl_info?.playurl?.stream?.length);
    if (!hasStream) {
      return { status: 'restricted', ...(uname ? { displayName: uname } : {}), streamTitle: title, error: new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限，请检查 Cookie 配置', { retryable: false }).toObject() };
    }
    // B站每次开播的 live_time 不同，用它标识本场直播，避免把同一房间的多次开播误判为同一场。
    const liveTime = data.data.live_time;
    const sessionId = liveTime && liveTime > 0 ? `${roomId}:${liveTime}` : `live_${roomId}_${Date.now()}`;
    return {
      status: 'live',
      streamSessionId: sessionId,
      streamTitle: title,
      ...(uname ? { displayName: uname } : {}),
      availableQualities: this.availableQns(data).map(qnToQuality),
    };
  }

  async getStreamUrl(roomUrl: string, quality: Quality, cookie?: string): Promise<StreamUrlResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) throw new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {});
    let data: BiliPlayResponse;
    try {
      data = await this.fetchPlayInfo(roomId, cookie, BILI_QN[quality]);
    } catch (err) {
      if (isNetworkError(err)) throw new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true });
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
    }
    if (data.code !== 0 || !data.data) {
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
    }
    const picked = this.pickStream(data, BILI_QN[quality]);
    if (!picked) {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '无法获取直播流，可能需要 Cookie 或该房间受限', { retryable: false });
    }
    return {
      url: picked.url,
      format: picked.format,
      actualQuality: qnToQuality(picked.actualQn),
      headers: { 'User-Agent': UA, Referer: `${this.roomBase}/${roomId}`, Origin: this.roomBase },
    };
  }
}

function rankProtocol(name: string | undefined): number {
  if (name === 'http_stream') return 0;
  if (name === 'http_hls') return 1;
  return 2;
}

function rankFormat(name: string | undefined): number {
  if (name === 'flv') return 0;
  if (name === 'ts') return 1;
  if (name === 'fmp4') return 2;
  return 3;
}

function rankCodec(name: string | undefined): number {
  if (name === 'avc') return 0;
  if (name === 'hevc') return 1;
  return 2;
}

function pickQn(accept: number[], target: number): number {
  const sorted = [...accept].sort((a, b) => b - a);
  const exactOrLower = sorted.find((q) => q <= target);
  // 目标档位不可用时的回退：取最低可用档（最接近目标），而不是最高档（原画）——
  // 否则设置 360p/720p 录制而房间未提供该档时会直接录成原画（PrePan：非原画录制历史仍显示原画）。
  return exactOrLower ?? sorted[sorted.length - 1] ?? 0;
}

/** 档位匹配比较：a 优于 b 当且仅当——a ≤ target（命中目标或更低）时优先；同侧取更接近 target 的。 */
function betterQnMatch(a: number, b: number, target: number): boolean {
  const aOk = a > 0 && a <= target;
  const bOk = b > 0 && b <= target;
  if (aOk && !bOk) return true;
  if (!aOk && bOk) return false;
  if (aOk && bOk) return a > b; // 都在目标内，取更高档
  return a > 0 && b > 0 && a < b; // 都高于目标（不可达），取最低档
}

export type { ErrorObject };
