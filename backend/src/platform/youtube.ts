import type {
  PlatformAdapter,
  LiveStatusResult,
  StreamUrlResult,
  RecordingSourceResult,
  Quality,
} from "./adapter.js";
import { AppError } from "../types/error.js";
import { normalizeYoutubeUrl, parseYoutubeUrl } from "./youtube-url.js";
import {
  extractYoutube,
  YOUTUBE_SNAPSHOT_TTL_MS,
  type YoutubeInfo,
} from "./youtube-runtime.js";

const HEIGHTS: Record<Quality, number> = {
  original: Infinity,
  "1080p": 1080,
  "720p": 720,
  "540p": 540,
  "360p": 360,
};
export function youtubeQuality(info: YoutubeInfo, requested: Quality): Quality {
  const heights = (info.formats ?? [])
    .filter((f) => f.vcodec !== "none")
    .map((f) => f.height ?? 0)
    .filter((h) => h > 0);
  const limit = HEIGHTS[requested];
  const eligible = heights.filter((h) => h <= limit);
  const height = Math.max(0, ...(eligible.length ? eligible : heights));
  if (!height || requested === "original") return requested;
  return height > 1080 ? "original" : height >= 1080
    ? "1080p"
    : height >= 720
      ? "720p"
      : height >= 540
        ? "540p"
        : "360p";
}
export function youtubeFormat(quality: Quality): string {
  const height = HEIGHTS[quality];
  const cap = Number.isFinite(height) ? `[height<=${height}]` : "";
  return cap ? `bv${cap}+ba/b${cap}/bv+ba/b` : "bv+ba/b";
}

interface SourceStore {
  load(url: string): string | undefined;
  save(url: string, channel: string): void;
}
export class YoutubeAdapter implements PlatformAdapter {
  readonly platform = "youtube" as const;
  private current = new Map<string, string>();
  private profiles = new Map<
    string,
    Pick<LiveStatusResult, "displayName" | "avatarUrl">
  >();
  private profileLoads = new Map<string, { until: number; value: Promise<YoutubeInfo | null> }>();
  private rememberProfile(url: string, info: YoutubeInfo): void {
    const avatar = info.thumbnails?.find((item) =>
      /^https:\/\/(?:yt3\.googleusercontent\.com|yt3\.ggpht\.com)\//.test(
        item.url,
      ),
    )?.url;
    const name = info.channel ?? info.uploader;
    if (!name && !avatar) return;
    const previous = this.profiles.get(url);
    this.profiles.delete(url);
    this.profiles.set(url, {
      ...previous,
      ...(name ? { displayName: name } : {}),
      ...(avatar ? { avatarUrl: avatar } : {}),
    });
    if (this.profiles.size > 512)
      this.profiles.delete(this.profiles.keys().next().value!);
  }

  private async loadChannelProfile(raw: string, info: YoutubeInfo, cookie?: string): Promise<void> {
    if (this.profiles.get(raw)?.avatarUrl || !/^UC[\w-]{22}$/.test(info.channel_id ?? '')) return;
    const channelUrl = `https://www.youtube.com/channel/${info.channel_id}/streams`;
    let cached = this.profileLoads.get(channelUrl);
    if (!cached || cached.until <= Date.now()) {
      const value = this.extract(channelUrl, cookie, true).catch(() => null);
      cached = { until: Date.now() + 60_000, value };
      this.profileLoads.delete(channelUrl);
      this.profileLoads.set(channelUrl, cached);
      if (this.profileLoads.size > 128) this.profileLoads.delete(this.profileLoads.keys().next().value!);
    }
    const profile = await cached.value;
    if (profile) this.rememberProfile(raw, profile);
  }

  constructor(
    private readonly extract: typeof extractYoutube = extractYoutube,
    private readonly store?: SourceStore,
  ) {}
  normalizeUrl(raw: string): string {
    return normalizeYoutubeUrl(raw);
  }
  validateUrl(raw: string): boolean {
    return parseYoutubeUrl(raw) !== null;
  }
  async resolveRoomUrl(raw: string, cookie?: string): Promise<string> {
    const target = parseYoutubeUrl(raw);
    if (!target)
      throw new AppError(
        "ROOM_LINK_INVALID",
        "请输入有效的 YouTube 频道或直播视频链接",
      );
    if (target.kind === "video" || target.id.startsWith("UC"))
      return target.url;
    const saved = this.store?.load(target.url);
    if (saved) return saved;
    const info = await this.extract(`${target.url}/streams`, cookie, true);
    const channel =
      info.channel_id ?? info.entries?.find((e) => e.channel_id)?.channel_id;
    if (!channel || !/^UC[\w-]{22}$/.test(channel))
      throw new AppError("ROOM_CONTENT_UNAVAILABLE", "无法确认 YouTube 频道");
    const canonical = `https://www.youtube.com/channel/${channel}`;
    this.store?.save(target.url, canonical);
    this.rememberProfile(canonical, info);
    return canonical;
  }
  getRoomPageUrl(raw: string): string | undefined {
    return this.current.get(raw) ?? parseYoutubeUrl(raw)?.url;
  }
  async liveInfo(
    raw: string,
    cookie?: string,
    sessionId?: string | null,
    withArtwork = false,
  ): Promise<YoutubeInfo | null> {
    const target = parseYoutubeUrl(raw);
    if (!target) throw new AppError("ROOM_LINK_INVALID", "YouTube 链接无效");
    let info: YoutubeInfo;
    if (sessionId)
      info = await this.extract(
        `https://www.youtube.com/watch?v=${sessionId}`,
        cookie,
      );
    else if (target.kind === "video")
      info = await this.extract(target.url, cookie);
    else {
      const list = await this.extract(`${target.url}/streams`, cookie, true);
      this.rememberProfile(raw, list);
      const live = (list.entries ?? []).filter(
        (e) => e.live_status === "is_live" || e.is_live,
      );
      const previous = this.current.get(raw)?.split("v=")[1];
      const selected =
        live.find((e) => e.id === previous) ??
        live.sort(
          (a, b) =>
            (a.release_timestamp ?? a.timestamp ?? Infinity) -
              (b.release_timestamp ?? b.timestamp ?? Infinity) ||
            a.id.localeCompare(b.id),
        )[0];
      if (!selected) {
        this.current.delete(raw);
        return null;
      }
      info = await this.extract(
        `https://www.youtube.com/watch?v=${selected.id}`,
        cookie,
      );
    }
    this.rememberProfile(raw, info);
    if (withArtwork) await this.loadChannelProfile(raw, info, cookie);
    if (info.live_status !== "is_live" && !info.is_live) {
      this.current.delete(raw);
      return null;
    }
    if (!/^[\w-]{11}$/.test(info.id))
      throw new AppError("ROOM_CONTENT_UNAVAILABLE", "YouTube 场次信息无效");
    this.current.delete(raw);
    this.current.set(raw, `https://www.youtube.com/watch?v=${info.id}`);
    if (this.current.size > 512)
      this.current.delete(this.current.keys().next().value!);
    return info;
  }
  async checkLiveStatus(
    raw: string,
    cookie?: string,
  ): Promise<LiveStatusResult> {
    return this.readStatus(raw, cookie, true);
  }
  async checkLiveStatusForStartup(raw: string, cookie?: string): Promise<LiveStatusResult> {
    return this.readStatus(raw, cookie, false);
  }
  private async readStatus(raw: string, cookie: string | undefined, withArtwork: boolean): Promise<LiveStatusResult> {
    try {
      const info = await this.liveInfo(raw, cookie, undefined, withArtwork);
      if (!info) return { status: "offline", ...this.profiles.get(raw) };
      const max = Math.max(
        0,
        ...(info.formats ?? []).map((f) => f.height ?? 0),
      );
      return {
        status: "live",
        ...this.profiles.get(raw),
        streamSessionId: info.id,
        streamTitle: info.title ?? "YouTube 直播",
        displayName: info.channel ?? info.uploader ?? "YouTube",
        ...(info.thumbnail ? { liveCoverUrl: info.thumbnail } : {}),
        ...(info.release_timestamp
          ? {
              platformStartedAt: new Date(
                info.release_timestamp * 1000,
              ).toISOString(),
            }
          : {}),
        availableQualities: (Object.keys(HEIGHTS) as Quality[]).filter(
          (q) => q === "original" || HEIGHTS[q] <= max,
        ),
      };
    } catch (error) {
      const err =
        error instanceof AppError
          ? error
          : new AppError("NETWORK_UNAVAILABLE", "YouTube 状态检测失败", {
              retryable: true,
            });
      if (err.code === "ROOM_CONTENT_UNAVAILABLE") {
        this.current.delete(raw);
        return { status: "offline", ...this.profiles.get(raw) };
      }
      return {
        ...this.profiles.get(raw),
        status:
          err.code === "PLATFORM_ACCESS_RESTRICTED" ? "restricted" : "error",
        error: err.toObject(),
      };
    }
  }
  private stream(
    info: YoutubeInfo,
    quality: Quality,
    cookie?: string,
  ): StreamUrlResult {
    return {
      url: `https://www.youtube.com/watch?v=${info.id}`,
      format: "youtube",
      actualQuality: youtubeQuality(info, quality),
      streamSessionId: info.id,
      youtube: {
        videoId: info.id,
        formatSelector: youtubeFormat(quality),
        audioCodec: info.requested_formats?.find(f => f.acodec && f.acodec !== 'none')?.acodec ?? info.acodec ?? 'aac',
        ...(cookie ? { cookie } : {}),
        ...(info.formats?.some(f => f.url) ? {
          snapshot: {
            json: JSON.stringify(info),
            expiresAt:
              (info.epoch ? info.epoch * 1000 : Date.now()) + YOUTUBE_SNAPSHOT_TTL_MS,
          },
        } : {}),
      },
    };
  }
  async getStreamUrl(
    raw: string,
    quality: Quality,
    cookie?: string,
  ): Promise<StreamUrlResult> {
    const info = await this.liveInfo(raw, cookie);
    if (!info)
      throw new AppError(
        "ROOM_CONTENT_UNAVAILABLE",
        "YouTube 直播尚未开始或已经结束",
      );
    return this.stream(info, quality, cookie);
  }
  async resolveRecordingSource(
    raw: string,
    quality: Quality,
    cookie?: string,
    context?: { streamSessionId?: string | null },
  ): Promise<RecordingSourceResult> {
    try {
      const info = await this.liveInfo(raw, cookie, context?.streamSessionId);
      return info
        ? { status: "live", stream: this.stream(info, quality, cookie) }
        : { status: "offline" };
    } catch (error) {
      const err =
        error instanceof AppError
          ? error
          : new AppError("NETWORK_UNAVAILABLE", "YouTube 直播恢复失败", {
              retryable: true,
            });
      if (err.code === "ROOM_CONTENT_UNAVAILABLE") {
        this.current.delete(raw);
        return { status: "offline" };
      }
      return {
        status:
          err.code === "PLATFORM_ACCESS_RESTRICTED" ? "restricted" : "error",
        error: err.toObject(),
      };
    }
  }
}
