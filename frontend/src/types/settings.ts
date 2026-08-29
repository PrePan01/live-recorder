export type Quality = 'original' | '1080p' | '720p' | '360p';

export type RecordingFormat = 'source_flv' | 'mp4_after';

export type ThemePreference = 'light' | 'dark' | 'system';

export type PlatformIntervals = {
  default: number;
  bilibili: number;
  douyin: number;
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
  quality: Quality;
  recordingFormat: RecordingFormat;
  autoRecord: boolean;
  retry: RetryPolicy;
  diskGuard: DiskGuard;
  mail: MailSettings;
  /** v1.3：抖音 Cookie（SecretStore 存，GET 仅回显是否存在，永回明文） */
  douyinCookie: { hasCookie: boolean };
  /** V5：主题偏好（light | dark | system） */
  theme?: ThemePreference;
}

export interface MailInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  from?: string;
  recipients?: string[];
  /** 仅更新密码时传入 */
  password?: string;
}

export interface SettingsInput {
  recordingDirectory?: string;
  maxConcurrentRecordings?: number;
  checkIntervalSec?: Partial<PlatformIntervals>;
  quality?: Quality;
  recordingFormat?: RecordingFormat;
  autoRecord?: boolean;
  mail?: MailInput;
  /** 填写新 Cookie 或传空字符串清除；GET 不回显 */
  douyinCookie?: string;
  /** V5：主题偏好 */
  theme?: ThemePreference;
}

