import type { Quality } from './recording';

export type PlatformIntervals = {
  default: number;
  bilibili: number;
  douyin: number;
};

export interface MailSettings {
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  to: string | null;
  useTls: boolean;
  /** true 表示 SecretStore 中已存密码；响应永不回显明文 */
  passwordSet: boolean;
}

export interface Settings {
  saveDirectory: string;
  maxConcurrency: number;
  checkIntervalSec: PlatformIntervals;
  defaultQuality: Quality;
  mail: MailSettings;
}

export interface SettingsInput {
  saveDirectory?: string;
  maxConcurrency?: number;
  checkIntervalSec?: Partial<PlatformIntervals>;
  defaultQuality?: Quality;
  mail?: Partial<Omit<MailSettings, 'passwordSet'>> & { password?: string };
}

export interface DirectoryValidation {
  valid: boolean;
  writable: boolean;
  message: string | null;
}
