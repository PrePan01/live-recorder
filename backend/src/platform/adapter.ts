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

export interface StreamUrlResult {
  url: string;
  format: "flv" | "hls";
  actualQuality: Quality;
  headers?: Record<string, string>;
}

export type RecordingSourceResult =
  | { status: "live"; stream: StreamUrlResult }
  | { status: "offline"; error?: ErrorObject }
  | { status: "error" | "restricted"; error: ErrorObject };

export interface PlatformAdapter {
  readonly platform: Platform;
  resolveRecordingSource?(
    roomUrl: string,
    quality: Quality,
    cookie?: string,
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
