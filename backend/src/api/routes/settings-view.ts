import type { Services } from '../../core/services.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import type { AppSettings, SettingsView } from '../../types/index.js';
import { DOUYIN_COOKIE_KEY, MAIL_PASSWORD_KEY } from '../../security/keys.js';

export async function settingsView(services: Services): Promise<SettingsView> {
  const stored = services.settings.load();
  const settings: AppSettings = stored ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
  const passwordSet = await services.secretStore.has(MAIL_PASSWORD_KEY);
  const hasDouyinCookie = await services.secretStore.has(DOUYIN_COOKIE_KEY);
  const mail = { ...settings.mail, passwordSet };
  return {
    recordingDirectory: settings.recordingDirectory,
    maxConcurrentRecordings: settings.maxConcurrentRecordings,
    quality: settings.quality,
    recordingFormat: settings.recordingFormat ?? 'source_flv',
    autoRecord: settings.autoRecord ?? true,
    checkIntervalSec: settings.checkIntervalSec,
    retry: settings.retry,
    diskGuard: settings.diskGuard,
    mail,
    douyinCookie: { hasCookie: hasDouyinCookie },
    theme: settings.theme ?? 'system',
    notifications: settings.notifications ?? structuredClone(DEFAULT_SETTINGS.notifications),
    pipeline: settings.pipeline ?? structuredClone(DEFAULT_SETTINGS.pipeline),
    namingRule: settings.namingRule ?? DEFAULT_SETTINGS.namingRule,
    confirmAfterComplete: settings.confirmAfterComplete ?? false,
  };
}