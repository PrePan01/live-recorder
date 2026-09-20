import { AppError } from "../types/error.js";
import type { Quality } from "../types/index.js";
import type {
  LiveStatusResult,
  PlatformAdapter,
  StreamUrlResult,
} from "./adapter.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PLATFORM_REQUEST_TIMEOUT_MS = 8_000;
const PLATFORM_REQUEST_ATTEMPTS = 2;

/** 抖音 flv_pull_url 档位键 → 本地清晰度。 */
const RESOLUTION_QUALITY: Record<string, Quality> = {
  FULL_HD1: "original",
  HD1: "1080p",
  SD1: "720p",
  SD2: "360p",
};

/** 本地清晰度 → 抖音档位键（按偏好顺序取第一个存在的）。 */
const QUALITY_RESOLUTIONS: Record<Quality, string[]> = {
  original: ["FULL_HD1", "HD1", "SD1", "SD2"],
  "1080p": ["HD1", "FULL_HD1", "SD1", "SD2"],
  "720p": ["SD1", "HD1", "SD2", "FULL_HD1"],
  "360p": ["SD2", "SD1", "HD1", "FULL_HD1"],
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** 主播昵称 TTL 缓存：昵称基本不变，避免每次检测都拉直播间页面。 */
const NICK_TTL_MS = 10 * 60_000;

function classifyStatusError(
  json: DouyinEnterResponse,
  hasCookie: boolean,
): AppError {
  const message = JSON.stringify(json?.data ?? "");
  const code = json.status_code;
  if (code === 8 && hasCookie) {
    return new AppError(
      "DOUYIN_COOKIE_EXPIRED",
      "抖音授权已失效，请到设置页重新授权",
      { retryable: false },
    );
  }
  if (code === 10011) {
    const temporary =
      /服务繁忙|请稍后|busy|temporar|频繁|系统异常|try again/i.test(message);
    return new AppError(
      temporary ? "NETWORK_UNAVAILABLE" : "PLATFORM_CHANGED",
      temporary
        ? "抖音接口暂时不可用，请稍后重试"
        : "抖音接口请求参数异常，等待适配更新",
      { retryable: temporary },
    );
  }
  const credentialLike = /登录|风控|verify|RiskControl/i.test(message);
  if (credentialLike || !hasCookie) {
    return new AppError(
      "PLATFORM_ACCESS_RESTRICTED",
      hasCookie
        ? "平台访问受限，抖音授权可能已失效，请到设置页重新授权"
        : "平台访问受限，请检查抖音授权",
      { retryable: false },
    );
  }
  return new AppError("PLATFORM_CHANGED", "平台接口有变动，请稍后重试", {});
}

/** enter 响应里平台侧的提示文案（message/prompts），用于区分限流/结束等语义。 */
function enterHint(json: DouyinEnterResponse): string {
  const raw = json.data as unknown as
    { message?: unknown; prompts?: unknown } | undefined;
  if (typeof raw?.message === "string" && raw.message) return raw.message;
  return typeof raw?.prompts === "string" ? raw.prompts : "";
}

/**
 * “当前不在播”判定，只作用于**没有任何房间条目**（data.data 为空或缺失）的响应。
 * 抖音对已结束的房间有两种形状：
 * ① status_code=0 且没有房间条目（稳定未开播）；
 * ② 刚下播的一段时间内返回 status_code=30003 + “room has finished”，同样没有房间条目。
 * 以前只识别了 ①：②会落到 PLATFORM_CHANGED，于是房间下播后会误报“平台接口有变动”
 * （实测 status_code=30003 / hint="room has finished"）。
 * 凭证/风控类响应（8、10011、需登录等）不在本判定内，仍走原分类逻辑。
 */
function isNotLiveResponse(json: DouyinEnterResponse): boolean {
  if ((json.data?.data?.length ?? 0) > 0) return false;
  if (json.status_code === 0) return true;
  return (
    json.status_code === 30003 ||
    /room has finished|直播已结束|已下播/i.test(enterHint(json))
  );
}

/**
 * 抖音刚切换到开播时，enter 接口会先给出 status=2，随后才异步填充
 * flv_pull_url。它不是 Cookie/风控信号；将其视为受限会造成一次误告警，
 * 而手动检测恰好在地址生成后又会“恢复”。
 */
function hasLiveEntryWithoutStreamUrl(json: DouyinEnterResponse): boolean {
  const entry = json.data?.data?.[0];
  const flv = entry?.stream_url?.flv_pull_url;
  return (
    json.status_code === 0 &&
    entry?.status === 2 &&
    (!flv || Object.keys(flv).length === 0)
  );
}

function logEnterShape(
  roomId: string,
  json: DouyinEnterResponse,
  outcome: string,
): void {
  const entries = json.data?.data;
  const entry = entries?.[0];
  const flv = entry?.stream_url?.flv_pull_url;
  const hint = enterHint(json);
  console.warn(
    `[douyin-enter] room=${roomId} status_code=${json.status_code ?? "absent"} entries=${entries ? entries.length : "missing"} entryStatus=${entry?.status ?? "-"} flvKeys=${flv ? Object.keys(flv).length : "none"} outcome=${outcome} hint=${hint.slice(0, 120)}`,
  );
}

function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        "cause" in err))
  );
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin" as const;

  private nickCache = new Map<string, { name: string; at: number }>();
  /**
   * 所有 enter 请求（轮询、手动检测、录制断流后的确认/续录）共享同一条队列。
   * 这些路径使用同一 Cookie；若并发撞到抖音边缘节点，会集中得到 444，再被
   * 立即重试放大成所有房间同时报“接口暂时不可用”。
   */
  private enterRequestTail: Promise<void> = Promise.resolve();

  constructor(
    private fetcher: typeof fetch = fetch,
    private apiBase = "https://live.douyin.com/webcast/room/web/enter",
  ) {}

  /**
   * 主播昵称解析：抖音 enter 接口结构变更后不再返回 user.nickname（QA 验收 #2a 定位），
   * 改为从直播间页面（live.douyin.com/<roomId>）解析 data-anchor-info/SSR 中的主播昵称。
   * 带 TTL 缓存避免每次检测都拉大页面。
   *
   * 必须携带会话 Cookie：匿名请求会被抖音挡在“验证码中间页”，页面里既没有
   * data-anchor-info 也没有 nickname 字段，昵称解析必然失败（退化成用直播间标题充当昵称）。
   * 该页面与 enter 接口同属 live.douyin.com，使用同一份凭证不新增信任边界。
   */
  async fetchAnchorNickname(
    roomId: string,
    cookie?: string,
  ): Promise<string | null> {
    const cached = this.nickCache.get(roomId);
    if (cached && Date.now() - cached.at < NICK_TTL_MS) return cached.name;
    try {
      const res = await this.fetcher(`https://live.douyin.com/${roomId}`, {
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        headers: {
          "User-Agent": UA,
          Referer: "https://live.douyin.com/",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!res.ok) return null;
      const html = await res.text();
      let name = "";
      // ① data-anchor-info 属性：HTML 实体编码的 JSON（{nickname, avatar, ...}）。
      const attr = html.match(/data-anchor-info="([^"]*)"/);
      if (attr) {
        try {
          const info = JSON.parse(decodeEntities(attr[1]!)) as {
            nickname?: unknown;
          };
          const n =
            typeof info.nickname === "string" ? info.nickname.trim() : "";
          if (n) name = n;
        } catch {
          // 尝试其他来源
        }
      }
      // ② SSR JSON："nickname":"X" 或 \"nickname\":\"X\"。
      if (!name) {
        const m = html.match(
          /(?:\\?"nickname\\?"\s*:\s*\\?"|"nickname"\s*:\s*")([^"\\]{1,80})/,
        );
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
    return raw
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  }

  validateUrl(raw: string): boolean {
    return /^https?:\/\/(live\.douyin\.com)\/\d+/.test(raw.trim());
  }

  parseRoomId(roomUrl: string): string | null {
    const m = /^https?:\/\/(?:live\.douyin\.com)\/(\d+)/.exec(
      this.normalizeUrl(roomUrl),
    );
    return m?.[1] ?? null;
  }

  private async queueEnterRequest<T>(request: () => Promise<T>): Promise<T> {
    const previous = this.enterRequestTail;
    let release!: () => void;
    this.enterRequestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await request();
    } finally {
      release();
    }
  }

  private async fetchRoomInfo(
    roomId: string,
    cookie?: string,
  ): Promise<DouyinEnterResponse> {
    const params = new URLSearchParams({
      aid: "6383",
      app_name: "douyin_web",
      live_id: "1",
      device_platform: "web",
      enter_from: "web_live",
      // 抖音接口已切换为 web_rid（room_id_str 会返回 status_code=10011 Request params error）
      web_rid: roomId,
      enter_from_merge: "web_live",
      is_need_double_stream: "false",
    });
    const res = await this.queueEnterRequest(() =>
      this.fetcher(`${this.apiBase}/?${params}`, {
        signal: AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS),
        headers: {
          "User-Agent": UA,
          Referer: `https://live.douyin.com/${roomId}`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }),
    );
    if (!res.ok) {
      // 429/5xx 是抖音侧的暂时限流/抖动，并不表示 enter 响应结构已变。
      // 过去这里抛普通 Error，调用方会误报“平台接口有变动”；用户稍后手动
      // 检测成功正是这一误判的典型表现。
      if (
        res.status === 408 ||
        res.status === 425 ||
        res.status === 429 ||
        res.status >= 500
      ) {
        throw new AppError(
          "NETWORK_UNAVAILABLE",
          "平台暂时不可用，请稍后重试",
          { retryable: true, details: { httpStatus: res.status } },
        );
      }
      // 444 是抖音边缘节点直接掐断连接、不返回任何内容的非标准状态码。
      // 它也会在登录仍有效时偶发出现，不能据此使全部房间进入“授权失效”熔断。
      if (res.status === 444) {
        throw new AppError(
          "NETWORK_UNAVAILABLE",
          "抖音接口暂时不可用，请稍后重试",
          { retryable: true, details: { httpStatus: res.status } },
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new AppError(
          cookie ? "DOUYIN_COOKIE_EXPIRED" : "PLATFORM_ACCESS_RESTRICTED",
          cookie
            ? "抖音授权已失效，请到设置页重新授权"
            : "平台访问受限，请检查抖音授权",
          { retryable: false, details: { httpStatus: res.status } },
        );
      }
      throw new AppError(
        "NETWORK_UNAVAILABLE",
        "平台暂时无法访问，请稍后重试",
        {
          retryable: true,
          details: { httpStatus: res.status },
        },
      );
    }
    const text = await res.text();
    if (!text.trim()) {
      throw new AppError(
        "PLATFORM_ACCESS_RESTRICTED",
        "平台访问受限，请检查抖音授权",
        { retryable: false },
      );
    }
    let json: DouyinEnterResponse;
    try {
      json = JSON.parse(text) as DouyinEnterResponse;
    } catch {
      throw new AppError(
        "PLATFORM_ACCESS_RESTRICTED",
        "平台访问受限，请检查抖音授权",
        { retryable: false },
      );
    }
    return json;
  }

  /**
   * 抖音 CDN/API 会偶发限流或短暂 5xx。单次即时重试可消除这类瞬态失败，
   * 但不会掩盖鉴权失败或真正的响应结构变更。
   */
  private async fetchRoomInfoWithRetry(
    roomId: string,
    cookie?: string,
  ): Promise<DouyinEnterResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PLATFORM_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const data = await this.fetchRoomInfo(roomId, cookie);
        // 开播状态先于 CDN 拉流地址发布是正常的短暂中间态。立即复查一次，
        // 避免把它误判为授权失效；若仍未就绪，交给下一轮常规检测继续重试。
        if (!hasLiveEntryWithoutStreamUrl(data)) return data;
        lastError = new AppError(
          "NETWORK_UNAVAILABLE",
          "直播刚开播，正在等待平台生成流地址，请稍后重试",
          { retryable: true },
        );
        if (attempt + 1 === PLATFORM_REQUEST_ATTEMPTS) {
          logEnterShape(roomId, data, "LIVE_WITHOUT_STREAM_URL");
          throw lastError;
        }
      } catch (err) {
        lastError = err;
        const retryable =
          (err instanceof AppError && err.retryable) || isNetworkError(err);
        if (!retryable || attempt + 1 === PLATFORM_REQUEST_ATTEMPTS) throw err;
      }
    }
    throw lastError;
  }

  async checkLiveStatus(
    roomUrl: string,
    cookie?: string,
  ): Promise<LiveStatusResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId) {
      return {
        status: "error",
        error: new AppError(
          "ROOM_LINK_INVALID",
          "无效的直播间链接",
          {},
        ).toObject(),
      };
    }
    // 抖音未登录（本地没有 Cookie）时必须登录授权才能检测/观看/录制：不做任何匿名请求。
    // 匿名 enter 请求的结果不可靠——有时返回看似正常的数据（房间被判成离线，卡片上看不到
    // 任何报错，用户不知道要登录），有时长时间不返回，把房间一直留在「检测中」。直接按访问
    // 受限落库，保证未授权时卡片立刻提示去设置登录授权。
    if (!cookie) {
      return {
        status: "restricted",
        error: new AppError(
          "PLATFORM_ACCESS_RESTRICTED",
          "平台访问受限，请检查抖音授权",
          { retryable: false },
        ).toObject(),
      };
    }
    let data: DouyinEnterResponse;
    try {
      data = await this.fetchRoomInfoWithRetry(roomId, cookie);
    } catch (err) {
      if (err instanceof AppError) {
        if (
          err.code === "PLATFORM_ACCESS_RESTRICTED" ||
          err.code === "DOUYIN_COOKIE_EXPIRED"
        ) {
          return { status: "restricted", error: err.toObject() };
        }
        return { status: "error", error: err.toObject() };
      }
      return {
        status: "error",
        error: (isNetworkError(err)
          ? new AppError("NETWORK_UNAVAILABLE", "平台请求失败", {
              retryable: true,
            })
          : new AppError("PLATFORM_CHANGED", "平台接口有变动，请稍后重试", {})
        ).toObject(),
      };
    }
    const arr = data.data?.data;
    if (data.status_code !== 0 || !arr || arr.length === 0) {
      // 没有房间条目 = 这个房间当前不在播（未开播 / 刚下播），不是接口变了。
      if (isNotLiveResponse(data)) return { status: "offline" };
      const appErr = classifyStatusError(data, Boolean(cookie));
      logEnterShape(roomId, data, appErr.code);
      return {
        status:
          appErr.code === "PLATFORM_ACCESS_RESTRICTED" ||
          appErr.code === "DOUYIN_COOKIE_EXPIRED"
            ? "restricted"
            : "error",
        error: appErr.toObject(),
      };
    }
    const entry = arr[0];
    if (!entry) {
      return {
        status: "error",
        error: new AppError(
          "PLATFORM_CHANGED",
          "平台接口有变动，请稍后重试",
          {},
        ).toObject(),
      };
    }
    const nickname =
      entry.user?.nickname?.trim() ||
      (await this.fetchAnchorNickname(roomId, cookie)) ||
      "";
    const streamTitle = entry.title;
    const base = nickname
      ? {
          displayName: nickname,
          ...(streamTitle ? { streamTitle } : {}),
          titleSource: "adapter" as const,
          titleFallbackUsed: false,
        }
      : {
          ...(streamTitle ? { streamTitle } : {}),
          ...(await this.titleFallback(roomId, cookie)),
        };
    if (entry.status !== 2) {
      return { status: "offline", ...base };
    }
    const flv = entry.stream_url?.flv_pull_url;
    if (!flv || Object.keys(flv).length === 0) {
      return {
        status: "restricted",
        ...base,
        error: new AppError(
          "PLATFORM_ACCESS_RESTRICTED",
          "平台访问受限，请检查抖音授权",
          { retryable: false },
        ).toObject(),
      };
    }
    return {
      status: "live",
      ...base,
      streamSessionId: entry.id ?? roomId,
      availableQualities: Object.keys(flv)
        .map((k) => RESOLUTION_QUALITY[k])
        .filter((q): q is Quality => Boolean(q)),
    };
  }

  /**
   * #128 标题回退：主源缺标题/昵称时，用安全占位（不阻断录制）。
   * 验证过的回退源 = 房间号兜底占位；如需二级平台源可在 adapter 内扩展。
   */
  private async titleFallback(
    roomId: string,
    _cookie?: string,
  ): Promise<{
    displayName: string;
    titleSource: "fallback" | "placeholder";
    titleFallbackUsed: boolean;
  }> {
    // 回退源：以房间 id 安全占位（不含 Cookie/响应体，避免泄露）。
    return {
      displayName: `douyin_${roomId}`,
      titleSource: "placeholder",
      titleFallbackUsed: true,
    };
  }

  async getStreamUrl(
    roomUrl: string,
    quality: Quality,
    cookie?: string,
  ): Promise<StreamUrlResult> {
    const roomId = this.parseRoomId(roomUrl);
    if (!roomId)
      throw new AppError("ROOM_LINK_INVALID", "无效的直播间链接", {});
    // 同 checkLiveStatus：未登录时不尝试匿名取流，避免匿名拉到流后绕过「抖音需授权」的前提。
    if (!cookie)
      throw new AppError(
        "PLATFORM_ACCESS_RESTRICTED",
        "平台访问受限，请检查抖音授权",
        { retryable: false },
      );
    let data: DouyinEnterResponse;
    try {
      data = await this.fetchRoomInfoWithRetry(roomId, cookie);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isNetworkError(err))
        throw new AppError("NETWORK_UNAVAILABLE", "平台请求失败", {
          retryable: true,
        });
      throw new AppError("PLATFORM_CHANGED", "平台接口有变动，请稍后重试", {});
    }
    const arr = data.data?.data;
    if (data.status_code !== 0 || !arr || arr.length === 0) {
      // 同 checkLiveStatus：没有房间条目只说明"当前不在播"，不是接口变更。
      if (isNotLiveResponse(data))
        throw new AppError(
          "RECORDING_NOT_AVAILABLE",
          "直播间当前未开播，无法获取直播流",
          { retryable: false },
        );
      const appErr = classifyStatusError(data, Boolean(cookie));
      logEnterShape(roomId, data, appErr.code);
      throw appErr;
    }
    const entry = arr[0];
    if (!entry) {
      throw new AppError("PLATFORM_CHANGED", "平台接口有变动，请稍后重试", {});
    }
    const flv = entry.stream_url?.flv_pull_url;
    if (!flv || Object.keys(flv).length === 0) {
      throw new AppError(
        "PLATFORM_ACCESS_RESTRICTED",
        "无法获取直播流，请检查抖音授权或房间访问限制",
        { retryable: false },
      );
    }
    const picked = pickResolution(flv, quality);
    return {
      url: picked.url,
      format: "flv",
      actualQuality: picked.quality,
      headers: {
        "User-Agent": UA,
        Referer: `https://live.douyin.com/${roomId}`,
        Origin: "https://live.douyin.com",
      },
    };
  }
}

function pickResolution(
  flv: Record<string, string>,
  quality: Quality,
): { url: string; quality: Quality } {
  const ordered = QUALITY_RESOLUTIONS[quality];
  for (const key of ordered) {
    if (flv[key])
      return { url: flv[key]!, quality: RESOLUTION_QUALITY[key] ?? quality };
  }
  const fallbackKey = Object.keys(flv)[0]!;
  return {
    url: flv[fallbackKey]!,
    quality: RESOLUTION_QUALITY[fallbackKey] ?? quality,
  };
}
