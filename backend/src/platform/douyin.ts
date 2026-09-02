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

/** HTML 实体解码（主播昵称等字段）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** 主播昵称 TTL 缓存：昵称基本不变，避免每次检测都拉直播间页面。 */
const NICK_TTL_MS = 10 * 60_000;

/**
 * 区分抖音非 0 status_code 的根因：#56 第二部分——
 * 反爬/凭证（Cookie 缺失、失效/过期、被风控）→ PLATFORM_ACCESS_RESTRICTED 引导检查 Cookie；
 * 仅结构异常（连 status_code 都无法解析）→ PLATFORM_CHANGED 真接口变更。
 */
function classifyStatusError(json: DouyinEnterResponse, hasCookie: boolean): AppError {
  const message = String(json?.data && 'message' in json.data ? (json.data as unknown as { message?: string }).message : '');
  const code = json.status_code;
  // 凭证相关信号：请求参数错误/服务繁忙/需登录等（抖音风控常见 status_code）。
  const credentialLike = code === 10011 || /请求参数|服务繁忙|请稍后|登录|风控|verify|RiskControl/i.test(message);
  if (credentialLike || !hasCookie) {
    return new AppError('PLATFORM_ACCESS_RESTRICTED', hasCookie ? '平台访问受限，Cookie 可能已失效，请到设置页更新' : '平台访问受限，请配置抖音 Cookie', { retryable: false });
  }
  return new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {});
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || 'cause' in err));
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = 'douyin' as const;

  private nickCache = new Map<string, { name: string; at: number }>();

  constructor(
    private fetcher: typeof fetch = fetch,
    private apiBase = 'https://live.douyin.com/webcast/room/web/enter',
  ) {}

  /**
   * 主播昵称解析：抖音 enter 接口结构变更后不再返回 user.nickname（QA 验收 #2a 定位），
   * 改为从直播间页面（live.douyin.com/<roomId>）解析 data-anchor-info/SSR 中的主播昵称。
   * 带 TTL 缓存避免每次检测都拉大页面。
   */
  async fetchAnchorNickname(roomId: string): Promise<string | null> {
    const cached = this.nickCache.get(roomId);
    if (cached && Date.now() - cached.at < NICK_TTL_MS) return cached.name;
    try {
      const res = await this.fetcher(`https://live.douyin.com/${roomId}`, {
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        headers: { 'User-Agent': UA, Referer: 'https://live.douyin.com/' },
      });
      if (!res.ok) return null;
      const html = await res.text();
      let name = '';
      // ① data-anchor-info 属性：HTML 实体编码的 JSON（{nickname, avatar, ...}）。
      const attr = html.match(/data-anchor-info="([^"]*)"/);
      if (attr) {
        try {
          const info = JSON.parse(decodeEntities(attr[1]!)) as { nickname?: unknown };
          const n = typeof info.nickname === 'string' ? info.nickname.trim() : '';
          if (n) name = n;
        } catch {
          // 尝试其他来源
        }
      }
      // ② SSR JSON："nickname":"X" 或 \"nickname\":\"X\"。
      if (!name) {
        const m = html.match(/(?:\\?"nickname\\?"\s*:\s*\\?"|"nickname"\s*:\s*")([^"\\]{1,80})/);
        if (m) name = m[1]!.trim();
      }
      if (!name) return null;
      this.nickCache.set(roomId, { name, at: Date.now() });
      return name;
    } catch {
      return null;
    }
  }

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
      // 抖音接口已切换为 web_rid（room_id_str 会返回 status_code=10011 Request params error）
      web_rid: roomId,
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
      const appErr = classifyStatusError(data, Boolean(cookie));
      return { status: appErr.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: appErr.toObject() };
    }
    const entry = arr[0];
    if (!entry) {
      return { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，等待适配更新', {}).toObject() };
    }
    const nickname = entry.user?.nickname?.trim() || (await this.fetchAnchorNickname(roomId)) || '';
    const streamTitle = entry.title;
    // #128 标题回退加固：主源（enter 接口）取到昵称/标题 → adapter；
    // 主源缺标题/昵称 → 尝试回退源（无 Cookie 重拉或复用受限时的安全占位）。
    // 抖音 enter 结构变更后 user.nickname 缺失 → 从直播间页面解析主播昵称（QA 验收 #2a）；
    // 昵称仍缺失但标题存在时用标题兜底作显示名（否则添加抖音房间显示名检测失败）。
    const hasTitle = Boolean(nickname || streamTitle);
    const base = hasTitle
      ? {
          ...(nickname ? { displayName: nickname } : streamTitle ? { displayName: streamTitle } : {}),
          ...(streamTitle ? { streamTitle } : {}),
          titleSource: 'adapter' as const,
          titleFallbackUsed: false,
        }
      : await this.titleFallback(roomId, cookie);
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
      availableQualities: Object.keys(flv).map((k) => RESOLUTION_QUALITY[k]).filter((q): q is Quality => Boolean(q)),
    };
  }

  /**
   * #128 标题回退：主源缺标题/昵称时，用安全占位（不阻断录制）。
   * 验证过的回退源 = 房间号兜底占位；如需二级平台源可在 adapter 内扩展。
   */
  private async titleFallback(roomId: string, _cookie?: string): Promise<{ displayName: string; titleSource: 'fallback' | 'placeholder'; titleFallbackUsed: boolean }> {
    // 回退源：以房间 id 安全占位（不含 Cookie/响应体，避免泄露）。
    return { displayName: `douyin_${roomId}`, titleSource: 'placeholder', titleFallbackUsed: true };
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
      throw classifyStatusError(data, Boolean(cookie));
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
