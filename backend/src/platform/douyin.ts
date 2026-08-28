import { AppError } from '../types/error.js';
import type { Quality } from '../types/index.js';
import type { LiveStatusResult, PlatformAdapter, StreamUrlResult } from './adapter.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PLATFORM_REQUEST_TIMEOUT_MS = 8_000;

/** 抖音 flv_pull_url 档位键 → 本地清晰度。 */
const RESOLUTION_QUALITY: Record<string, Quality> = {
  FULL_HD1: 'original',
  HD1: '1080p',
  SD1: '720p',
  SD2: '360p',
};

/** 本地清晰度 → 抖音档位键（按偏好顺序取第一个存在的）。 */
const QUALITY_RESOLUTIONS: Record<Quality, string[]> = {
  original: ['FULL_HD1', 'HD1', 'SD1', 'SD2'],
  '1080p': ['HD1', 'FULL_HD1', 'SD1', 'SD2'],
  '720p': ['SD1', 'HD1', 'SD2', 'FULL_HD1'],
  '360p': ['SD2', 'SD1', 'HD1', 'FULL_HD1'],
};

interface DouyinEnterData {
  data?: Array<{
    id?: string;
    status?: number;
    title?: string;
    user?: { nickname?: string };
    stream_url?: {
      flv_pull_url?: Record<string, string>;
      default_resolution?: string;
    };
  }>;
}

interface DouyinEnterResponse {
  status_code?: number;
  data?: DouyinEnterData;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || 'cause' in err));
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = 'douyin' as const;

  constructor(
    private fetcher: typeof fetch = fetch,
    private apiBase = 'https://live.douyin.com/webcast/room/web/enter',
  ) {}

  normalizeUrl(raw: string): string {
    return raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  validateUrl(raw: string): boolean {
    return /^https?:\/\/(live\.douyin\.com)\/\d+/.test(raw.trim());
  }

  parseRoomId(roomUrl: string): string | null {
    const m = /^https?:\/\/(?:live\.douyin\.com)\/(\d+)/.exec(this.normalizeUrl(roomUrl));
    return m?.[1] ?? null;
  }

  private async fetchRoomInfo(roomId: string, cookie?: string): Promise<DouyinEnterResponse> {
    const params = new URLSearchParams({
      aid: '6383',
      app_name: 'douyin_web',
      live_id: '1',
      device_platform: 'web',
      enter_from: 'web_live',
      room_id_str: roomId,
      enter_from_merge: 'web_live',
      is_need_double_stream: 'false',
    });
    const res = await this.fetcher(`${this.apiBase}/?${params}`, {
      signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': UA,
        Referer: `https://live.douyin.com/${roomId}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) throw new Error(`douyin api http ${res.status}`);
    const text = await res.text();
    if (!text.trim()) {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限，请检查 Cookie 配置', { retryable: false });
    }
    let json: DouyinEnterResponse;
    try {
      json = JSON.parse(text) as DouyinEnterResponse;
    } catch {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限，请检查 Cookie 配置', { retryable: false });
    }
    return json;
  }

  async checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) {
      return { status: 'error', error: new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {}).toObject() };
    }
    let data: DouyinEnterResponse;
    try {
      data = await this.fetchRoomInfo(roomId, cookie);
    } catch (err) {
      if (err instanceof AppError) {
        if (err.code === 'PLATFORM_ACCESS_RESTRICTED') {
          return { status: 'restricted', error: err.toObject() };
        }
        return { status: 'error', error: err.toObject() };
      }
      return { status: 'error', error: (isNetworkError(err) ? new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true }) : new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {})).toObject() };
    }
    const arr = data.data?.data;
    if (data.status_code !== 0 || !arr || arr.length === 0) {
      return { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {}).toObject() };
    }
    const entry = arr[0];
    if (!entry) {
      return { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {}).toObject() };
    }
    const nickname = entry.user?.nickname;
    const base = { ...(nickname ? { displayName: nickname } : {}) };
    if (entry.status !== 2) {
      return { status: 'offline', ...base };
    }
    const flv = entry.stream_url?.flv_pull_url;
    if (!flv || Object.keys(flv).length === 0) {
      return { status: 'restricted', ...base, ...(entry.title ? { streamTitle: entry.title } : {}), error: new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限，请检查 Cookie 配置', { retryable: false }).toObject() };
    }
    return {
      status: 'live',
      ...base,
      streamSessionId: entry.id ?? roomId,
      ...(entry.title ? { streamTitle: entry.title } : {}),
      availableQualities: Object.keys(flv).map((k) => RESOLUTION_QUALITY[k]).filter((q): q is Quality => Boolean(q)),
    };
  }

  async getStreamUrl(roomUrl: string, quality: Quality, cookie?: string): Promise<StreamUrlResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) throw new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {});
    let data: DouyinEnterResponse;
    try {
      data = await this.fetchRoomInfo(roomId, cookie);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isNetworkError(err)) throw new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true });
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
    }
    const arr = data.data?.data;
    if (data.status_code !== 0 || !arr || arr.length === 0) {
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
    }
    const entry = arr[0];
    if (!entry) {
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
    }
    const flv = entry.stream_url?.flv_pull_url;
    if (!flv || Object.keys(flv).length === 0) {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '无法获取直播流，可能需要 Cookie 或该房间受限', { retryable: false });
    }
    const picked = pickResolution(flv, quality);
    return {
      url: picked.url,
      format: 'flv',
      actualQuality: picked.quality,
      headers: { 'User-Agent': UA, Referer: `https://live.douyin.com/${roomId}`, Origin: 'https://live.douyin.com' },
    };
  }
}

function pickResolution(flv: Record<string, string>, quality: Quality): { url: string; quality: Quality } {
  const ordered = QUALITY_RESOLUTIONS[quality];
  for (const key of ordered) {
    if (flv[key]) return { url: flv[key]!, quality: RESOLUTION_QUALITY[key] ?? quality };
  }
  const fallbackKey = Object.keys(flv)[0]!;
  return { url: flv[fallbackKey]!, quality: RESOLUTION_QUALITY[fallbackKey] ?? quality };
}
