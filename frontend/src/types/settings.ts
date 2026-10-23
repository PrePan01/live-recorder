export type Quality = "original" | "1080p" | "720p" | "540p" | "360p";

export type RecordingFormat = "source_flv" | "mp4_after";

export type ThemePreference = "light" | "dark" | "system";

import type { NotificationPreference } from "./notification";
import type { PipelineConfig } from "./pipeline";

export type PlatformIntervals = {
  default: number;
  bilibili: number;
  douyin: number;
  xiaohongshu?: number;
  youtube?: number;
};

export interface RetryPolicy {
  maxAttempts: number;
  delaysSeconds: number[];
}

export interface DiskGuard {
  minFreeBytes: number;
  minFreePercent: number;
}

export interface MailSettings {
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  from: string | null;
  recipients: string[];
  /** true 表示 SecretStore 已存密码；响应永不回显明文 */
  passwordSet: boolean;
}

export interface Settings {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  checkIntervalSec: PlatformIntervals;
  checkIntervalDefaults?: Record<
    "bilibili" | "douyin" | "xiaohongshu" | "youtube",
    number
  >;
  detectionLoad?: {
    perMinute: number;
    limitPerMinute: number;
    staggered: boolean;
    queued: number;
  };
  quality: Quality;
  recordingFormat: RecordingFormat;
  autoRecord: boolean;
  danmaku: { enabled: boolean };
  encodingMode?: "auto" | "software";
  retry: RetryPolicy;
  diskGuard: DiskGuard;
  mail: MailSettings;
  douyinCookie: { hasCookie: boolean };
  bilibiliCookie: { hasCookie: boolean };
  xiaohongshuCookie?: { hasCookie: boolean };
  youtubeCookie?: { hasCookie: boolean };
  theme?: ThemePreference;
  floatingRecorderSize?: number;
  notifications?: NotificationPreference;
  confirmAfterComplete?: boolean;
  preventSleepWhileRecording?: boolean;
  highlightBufferSeconds?: number;
  highlightEnabled?: boolean;
  pipeline?: PipelineConfig;
  namingRule?: string;
}

export interface SettingsDefaults {
  settings: Pick<
    Settings,
    | "maxConcurrentRecordings"
    | "checkIntervalSec"
    | "quality"
    | "autoRecord"
    | "danmaku"
    | "theme"
    | "floatingRecorderSize"
    | "confirmAfterComplete"
    | "preventSleepWhileRecording"
    | "highlightBufferSeconds"
    | "highlightEnabled"
    | "encodingMode"
  >;
  pipeline: Omit<PipelineConfig, "archiveDirectory" | "maxConcurrency">;
  notifications: NotificationPreference;
  naming: { namingRule: string };
  openlist: { enabled: boolean; deleteSourceAfterUpload: boolean };
  email: { enabled: boolean };
}

export interface MailInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  from?: string;
  recipients?: string[];
  password?: string;
}

export interface SettingsInput {
  recordingDirectory?: string;
  maxConcurrentRecordings?: number;
  checkIntervalSec?: Partial<PlatformIntervals>;
  quality?: Quality;
  recordingFormat?: RecordingFormat;
  autoRecord?: boolean;
  danmaku?: { enabled?: boolean };
  encodingMode?: "auto" | "software";
  mail?: MailInput;
  douyinCookie?: string;
  bilibiliCookie?: string;
  xiaohongshuCookie?: string;
  youtubeCookie?: "";
  theme?: ThemePreference;
  floatingRecorderSize?: number;
  confirmAfterComplete?: boolean;
  preventSleepWhileRecording?: boolean;
  highlightBufferSeconds?: number;
  highlightEnabled?: boolean;
}
