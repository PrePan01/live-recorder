import type { ErrorObject, Platform, Quality } from "../types/index.js";

export type { Quality };

export interface LiveStatusResult {
  status: "offline" | "live" | "restricted" | "error";
  streamSessionId?: string;
  platformStartedAt?: string;
  streamTitle?: string;
  displayName?: string;
  avatarUrl?: string;
  liveCoverUrl?: string;
  availableQualities?: Quality[];
  error?: ErrorObject;
  titleSource?: "adapter" | "fallback" | "placeholder";
  titleFallbackUsed?: boolean;
}

export interface YoutubeMediaSource {
  videoId: string;
  formatSelector: string;
  audioCodec?: string;
  cookie?: string;
  /** Short-lived extractor output, kept internal and never exposed in API/logs. */
  snapshot?: { json: string; expiresAt: number };
}

export interface StreamUrlResult {
  streamSessionId?: string;
  url: string;
  format: "flv" | "hls" | "youtube";
  youtube?: YoutubeMediaSource;
  actualQuality: Quality;
  headers?: Record<string, string>;
}

export type RecordingSourceResult =
  | { status: "live"; stream: StreamUrlResult }
  | { status: "offline"; error?: ErrorObject }
  | { status: "error" | "restricted"; error: ErrorObject };

export interface PlatformAdapter {
  readonly platform: Platform;
  resolveRoomUrl?(rawUrl: string, cookie?: string): Promise<string>;
  getRoomPageUrl?(rawUrl: string): string | undefined;
  checkLiveStatusForStartup?(roomUrl: string, cookie?: string): Promise<LiveStatusResult>;
  resolveRecordingSource?(
    roomUrl: string,
    quality: Quality,
    cookie?: string,
    context?: { streamSessionId?: string | null },
  ): Promise<RecordingSourceResult>;
  checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult>;
  getStreamUrl(
    roomUrl: string,
    quality: Quality,
    cookie?: string,
  ): Promise<StreamUrlResult>;
  normalizeUrl(rawUrl: string): string;
  validateUrl(rawUrl: string): boolean;
}
