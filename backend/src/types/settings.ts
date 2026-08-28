import type { Quality } from './recording.js';

export interface RetryConfig {
  maxAttempts: number;
  delaysSeconds: number[];
}

export interface DiskGuardConfig {
  minFreeBytes: number;
  minFreePercent: number;
}

export interface CheckIntervalSec {
  default: number;
  bilibili: number;
  douyin: number;
}

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  recipients: string[];
}

/** 输出视图：不回显密码，仅 passwordSet 派生标记（SecretStore 中是否存在键）。 */
export interface MailConfigView extends MailConfig {
  passwordSet: boolean;
}

/** 录制文件格式：source_flv=源 FLV 直写（.flv，无损最快）；mp4_after=完成后 ffmpeg 转封装 MP4。 */
export type RecordingFormat = 'source_flv' | 'mp4_after';

export interface AppSettings {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  /** 录制默认清晰度（阶段 C 生效）；recordings.quality 内部列记录实际使用值。 */
  quality: Quality;
  /** 录制格式（v4）：source_flv 直写或完成后转 MP4。 */
  recordingFormat: RecordingFormat;
  /** 检测到开播时是否自动录制（v4，#63）：默认 true；false=仅检测不自动录。 */
  autoRecord: boolean;
  checkIntervalSec: CheckIntervalSec;
  retry: RetryConfig;
  diskGuard: DiskGuardConfig;
  mail: MailConfig;
  /** 邮件去重窗口 v1 固定 30 分钟，不暴露到 /settings。 */
  dedupeWindowMinutes: number;
}

export interface SettingsView {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  quality: Quality;
  recordingFormat: RecordingFormat;
  autoRecord: boolean;
  checkIntervalSec: CheckIntervalSec;
  retry: RetryConfig;
  diskGuard: DiskGuardConfig;
  mail: MailConfigView;
  /** v1.3：抖音 Cookie 是否已配置（值存 SecretStore，不落盘、不回显）。 */
  douyinCookie: { hasCookie: boolean };
}
