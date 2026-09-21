import type { Services } from '../../core/services.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import type { AppSettings, SettingsView } from '../../types/index.js';
import { DOUYIN_COOKIE_KEY, BILIBILI_COOKIE_KEY, MAIL_PASSWORD_KEY } from '../../security/keys.js';
import { notificationPreference } from './notifications.js';

export async function settingsView(services: Services): Promise<SettingsView> {
  const stored = services.settings.load();
  const settings: AppSettings = stored ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
  const passwordSet = await services.secretStore.has(MAIL_PASSWORD_KEY);
  const hasDouyinCookie = await services.secretStore.has(DOUYIN_COOKIE_KEY);
  const hasBilibiliCookie = await services.secretStore.has(BILIBILI_COOKIE_KEY);
  const mail = { ...settings.mail, passwordSet };
  return {
    recordingDirectory: settings.recordingDirectory,
    maxConcurrentRecordings: settings.maxConcurrentRecordings,
    quality: settings.quality,
    recordingFormat: settings.recordingFormat ?? 'source_flv',
    autoRecord: settings.autoRecord ?? false,
    checkIntervalSec: settings.checkIntervalSec,
    retry: settings.retry,
    diskGuard: settings.diskGuard,
    mail,
    douyinCookie: { hasCookie: hasDouyinCookie },
    bilibiliCookie: { hasCookie: hasBilibiliCookie },
    theme: settings.theme ?? 'system',
    // 旧版本允许 30–128px；收紧范围后在视图层归一化，避免旧值让新滑块越界。
    floatingRecorderSize: Math.min(100, Math.max(20, settings.floatingRecorderSize ?? 36)),
    notifications: notificationPreference(services),
    pipeline: settings.pipeline ?? structuredClone(DEFAULT_SETTINGS.pipeline),
    namingRule: settings.namingRule ?? DEFAULT_SETTINGS.namingRule,
    confirmAfterComplete: settings.confirmAfterComplete ?? false,
    highlightBufferSeconds: settings.highlightBufferSeconds ?? 300,
    highlightEnabled: settings.highlightEnabled ?? true,
  };
}
