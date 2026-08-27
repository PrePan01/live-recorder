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

export interface AppSettings {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  /** 录制默认清晰度（阶段 C 生效）；recordings.quality 内部列记录实际使用值。 */
  quality: Quality;
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
  checkIntervalSec: CheckIntervalSec;
  retry: RetryConfig;
  diskGuard: DiskGuardConfig;
  mail: MailConfigView;
}
