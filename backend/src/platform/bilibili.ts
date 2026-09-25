import { unknownStatusFallback } from './status-fallback.js';
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
const PLATFORM_REQUEST_ATTEMPTS = 2;

/** 播放接口车道：interactive = 用户主动取流（预览/录制），优先于 background = 后台检测。 */
type PlayLane = 'interactive' | 'background';

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
  data?: { info?: { uname?: string; face?: string } };
}

interface BiliRoomInfoResponse {
  code?: number;
  data?: { title?: string; uid?: number };
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || 'cause' in err));
}

/**
 * 平台 HTTP 状态 → 用户看得懂的分类。
 * 5xx/限流是平台侧暂时不可用（可重试）；只有明确的接口不存在（404/405）才算"接口有变动"（410/501 按规格入其余桶）。
 * 过去任何非 2xx 都走"接口有变动、等待适配更新"，把一次平台抖动报成了需要等更新的故障，
 * 而且不重试。状态码只留在 details 里，不进给用户看的文案。
 */
function biliHttpError(status: number): AppError {
  if (status === 404 || status === 405) {
    return new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试', { details: { httpStatus: status } });
  }
  return new AppError('NETWORK_UNAVAILABLE', 'B站接口暂时不可用，请稍后重试', { retryable: true, details: { httpStatus: status } });
}

/** B站 live_time 是本场直播的秒级 Unix 时间；拒绝明显无效或未来的值。 */
function platformStartedAt(liveTime: number | undefined): string | undefined {
  if (!Number.isInteger(liveTime) || !liveTime || liveTime < 1_420_070_400) return undefined;
  const ms = liveTime * 1_000;
  if (!Number.isSafeInteger(ms) || ms > Date.now() + 5 * 60 * 1_000) return undefined;
  return new Date(ms).toISOString();
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly platform = 'bilibili' as const;
  /**
   * 轮询、手动检测与录制恢复共用 getRoomPlayInfo；统一排队，避免多个
   * 录制收尾和调度批次同时携带同一 Cookie 撞向播放接口。
   *
   * 但不能只是普通 FIFO：用户主动的取流（打开预览 / 开始录制）会被“刷新全部房间”
   * 这类批量检测长时间排在后面。因此分两条车道，interactive 永远优先于 background，
   * 同一时刻仍只跑一个请求。
   */
  private playBusy = false;
  private playLanes: Record<PlayLane, Array<() => void>> = {
    interactive: [],
    background: [],
  };

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

  /**
   * 同一条车道内按到达顺序唤醒；interactive 车道永远先于 background，
   * 保证用户主动取流只排在“正在跑的那一个”请求后面，而不是整批检测后面。
   */
  private async runPlayRequest<T>(lane: PlayLane, request: () => Promise<T>): Promise<T> {
    if (this.playBusy) {
      // 被唤醒即代表已接管占用（release 直接移交，不在交接间隙放开占用，避免被新请求插队）。
      await new Promise<void>((resolve) => this.playLanes[lane].push(resolve));
    } else {
      this.playBusy = true;
    }
    try {
      return await request();
    } finally {
      const next = this.playLanes.interactive.shift() ?? this.playLanes.background.shift();
      if (next) next();
      else this.playBusy = false;
    }
  }

  private async fetchPlayInfoOnce(roomId: number, cookie?: string, qn?: number, lane: PlayLane = 'background'): Promise<BiliPlayResponse> {
    const params = new URLSearchParams({
      room_id: String(roomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      qn: String(qn ?? BILI_QN.original),
      platform: 'web',
      ptype: '8',
    });
    const res = await this.runPlayRequest(lane, () => this.fetcher(`${this.apiBase}/xlive/web-room/v2/index/getRoomPlayInfo?${params}`, {
      signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': UA,
        Referer: `${this.roomBase}/${roomId}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }));
    if (!res.ok) throw biliHttpError(res.status);
    return (await res.json()) as BiliPlayResponse;
  }

  private async fetchPlayInfo(roomId: number, cookie?: string, qn?: number, lane: PlayLane = 'background'): Promise<BiliPlayResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PLATFORM_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        return await this.fetchPlayInfoOnce(roomId, cookie, qn, lane);
      } catch (err) {
        lastError = err;
        const retryable = (err instanceof AppError && err.retryable) || isNetworkError(err);
        if (!retryable || attempt + 1 === PLATFORM_REQUEST_ATTEMPTS) throw err;
      }
    }
    throw lastError;
  }

  /** getRoomPlayInfo 响应已不含主播名/标题；用 get_anchor_in_room 取昵称、get_info 取标题，均免 Cookie 且无风控。 */
  private async fetchRoomMeta(roomId: number): Promise<{ uname?: string; title?: string; face?: string }> {
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
    const face = anchor?.code === 0 ? anchor.data?.info?.face : undefined;
    const title = info?.code === 0 ? info.data?.title : undefined;
    return { ...(uname ? { uname } : {}), ...(title ? { title } : {}), ...(face ? { face } : {}) };
  }

  /** 取流：优先 http_stream/flv + avc；在全部 codec 中选择最接近目标档位的流。
   *
   *  画质一律以 `current_qn` 为准：那是服务端对本次 `qn` 请求的实际答复，最终 URL 里的 `qn` 参数
   *  与它一致。`accept_qn` 只是该流「支持」的档位清单，**匿名请求同样会列出 10000（原画）**——
   *  用它推断实际画质会把「服务端其实只给了超清」谎报成「原画」，用户看到原画却录到低档。
   *  实测（未登录，qn=10000）：accept_qn=[10000,400,250] 而 current_qn=250、URL qn=250。 */
  private pickStream(data: BiliPlayResponse, targetQn: number): { url: string; format: 'flv' | 'hls'; actualQn: number } | null {
    const streams = data.data?.playurl_info?.playurl?.stream ?? [];
    const ordered = [...streams].sort((a, b) => rankProtocol(a.protocol_name) - rankProtocol(b.protocol_name));
    let best: { url: string; format: 'flv' | 'hls'; actualQn: number } | null = null;
    for (const stream of ordered) {
      const formats = [...(stream.format ?? [])].sort((a, b) => rankFormat(a.format_name) - rankFormat(b.format_name));
      for (const fmt of formats) {
        const codecs = [...(fmt.codec ?? [])].sort((a, b) => rankCodec(a.codec_name) - rankCodec(b.codec_name));
        for (const codec of codecs) {
          const granted = codec.current_qn ?? 0;
          const info = codec.url_info?.[0];
          if (!info?.host || !codec.base_url) continue;
          const isFlv = fmt.format_name === 'flv' || codec.base_url.includes('.flv');
          const candidate: { url: string; format: 'flv' | 'hls'; actualQn: number } = {
            url: `${info.host}${codec.base_url}${info.extra ?? ''}`,
            format: isFlv ? 'flv' : 'hls',
            actualQn: granted,
          };
          // 多个 codec 的 current_qn 通常相同（画质由请求参数协商），此处仅作稳健的择优。
          if (!best || betterQnMatch(candidate.actualQn, best.actualQn, targetQn)) best = candidate;
        }
      }
    }
    return best;
  }

  /**
   * 「可用档位」= 该流支持的档位 ∩ 本次服务端实际授予的上限（current_qn）。
   * 不做这层过滤时，匿名用户也会被告知「可用原画」，与本适配器的实际取流结果矛盾。
   */
  private availableQns(data: BiliPlayResponse): number[] {
    const set = new Set<number>();
    let ceiling = 0;
    for (const stream of data.data?.playurl_info?.playurl?.stream ?? []) {
      for (const fmt of stream.format ?? []) {
        for (const codec of fmt.codec ?? []) {
          for (const qn of codec.accept_qn ?? []) set.add(qn);
          if (codec.current_qn) {
            set.add(codec.current_qn);
            ceiling = Math.max(ceiling, codec.current_qn);
          }
        }
      }
    }
    if (ceiling <= 0) return [...set].sort((a, b) => b - a);
    return [...set].filter((qn) => qn <= ceiling).sort((a, b) => b - a);
  }

  async checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) {
      return { status: 'error', error: new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {}).toObject() };
    }
    let data: BiliPlayResponse;
    try {
      data = await this.fetchPlayInfo(roomId, cookie, undefined, 'background');
    } catch (err) {
      // 适配器内部已按状态码分好类（含可重试标记），不能在这里被拍平成"接口有变动"。
      if (err instanceof AppError) {
        return { status: err.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: err.toObject() };
      }
      return { status: 'error', error: (isNetworkError(err) ? new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true }) : new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试', {})).toObject() };
    }
    if (data.code !== 0 || !data.data) {
      // 第一层兜底：B 站 body 层业务码未知时说中性真话（原码透传），不断言接口变动。
      return { status: 'error', error: unknownStatusFallback({ code: data.code, hint: (data as { msg?: string; message?: string }).msg ?? (data as { message?: string }).message, scope: 'bilibili-room' }).toObject() };
    }
    // getRoomPlayInfo 已不再返回 room_info/anchor_info，名称信息改由 get_anchor_in_room/get_info 补充。
    const meta = await this.fetchRoomMeta(roomId);
    const title = data.data.room_info?.title ?? meta.title ?? '';
    const uname = data.data.anchor_info?.base_info?.uname ?? meta.uname;
    // 头像取自已在调的 get_anchor_in_room（0 额外请求）；缺失降级不置空。
    const face = meta.face?.trim() || undefined;
    const avatarUrl = face && /^https?:\/\//.test(face) ? face : undefined;
    if (data.data.live_status !== 1) {
      return { status: 'offline', ...(uname ? { displayName: uname } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
    }
    const hasStream = Boolean(data.data.playurl_info?.playurl?.stream?.length);
    if (!hasStream) {
      return { status: 'restricted', ...(uname ? { displayName: uname } : {}), ...(avatarUrl ? { avatarUrl } : {}), streamTitle: title, error: new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限，请检查B站授权', { retryable: false }).toObject() };
    }
    // B站每次开播的 live_time 不同，用它标识本场直播，避免把同一房间的多次开播误判为同一场。
    const liveTime = data.data.live_time;
    const sessionId = liveTime && liveTime > 0 ? `${roomId}:${liveTime}` : `live_${roomId}_${Date.now()}`;
    const startedAt = platformStartedAt(liveTime);
    return {
      status: 'live',
      streamSessionId: sessionId,
      ...(startedAt ? { platformStartedAt: startedAt } : {}),
      streamTitle: title,
      ...(uname ? { displayName: uname } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      availableQualities: [...new Set(this.availableQns(data).map(qnToQuality))],
    };
  }

  async getStreamUrl(roomUrl: string, quality: Quality, cookie?: string): Promise<StreamUrlResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) throw new AppError('ROOM_LINK_INVALID', '无效的直播间链接', {});
    let data: BiliPlayResponse;
    try {
      // 取流是用户主动操作（打开预览 / 开始录制）：走 interactive 车道，
      // 只排在正在执行的那一个请求之后，不被后台批量检测堵住。
      data = await this.fetchPlayInfo(roomId, cookie, BILI_QN[quality], 'interactive');
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isNetworkError(err)) throw new AppError('NETWORK_UNAVAILABLE', '平台请求失败', { retryable: true });
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试', {});
    }
    if (data.code !== 0 || !data.data) {
      throw new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试', {});
    }
    const picked = this.pickStream(data, BILI_QN[quality]);
    if (!picked) {
      throw new AppError('PLATFORM_ACCESS_RESTRICTED', '无法获取直播流，请检查B站授权或该房间访问限制', { retryable: false });
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
