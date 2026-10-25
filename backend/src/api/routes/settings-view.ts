import { QMSG_KEY } from '../../security/keys.js';
import { YOUTUBE_COOKIE_KEY } from "../../security/keys.js";
import type { Services } from "../../core/services.js";
import { DEFAULT_SETTINGS } from "../../config/defaults.js";
import type { AppSettings, SettingsView } from "../../types/index.js";
import {
  DOUYIN_COOKIE_KEY,
  BILIBILI_COOKIE_KEY,
  XIAOHONGSHU_COOKIE_KEY,
  MAIL_PASSWORD_KEY,
} from "../../security/keys.js";
import { notificationPreference } from "./notifications.js";
import { detectionLoad } from "../../config/check-guard.js";
import { platformCheckInterval, resolveCheckInterval } from "../../config/room-policy.js";

export async function settingsView(services: Services): Promise<SettingsView> {
  const stored = services.settings.load();
  const settings: AppSettings =
    stored ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
  const passwordSet = await services.secretStore.has(MAIL_PASSWORD_KEY);
  const hasDouyinCookie = await services.secretStore.has(DOUYIN_COOKIE_KEY);
  const hasBilibiliCookie = await services.secretStore.has(BILIBILI_COOKIE_KEY);
  const hasXiaohongshuCookie = await services.secretStore.has(
    XIAOHONGSHU_COOKIE_KEY,
  );
  const mail = { ...settings.mail, passwordSet };
  return {
    recordingDirectory: settings.recordingDirectory,
    maxConcurrentRecordings: settings.maxConcurrentRecordings,
    quality: settings.quality,
    recordingFormat: settings.recordingFormat ?? "source_flv",
    autoRecord: settings.autoRecord ?? false,
    checkIntervalSec: settings.checkIntervalSec,
    checkIntervalDefaults: {
      bilibili: platformCheckInterval('bilibili', settings),
      douyin: platformCheckInterval('douyin', settings),
      xiaohongshu: platformCheckInterval('xiaohongshu', settings),
      youtube: platformCheckInterval('youtube', settings),
    },
    detectionLoad: detectionLoad(
      services.rooms
        .listEnabled()
        .map((room) => resolveCheckInterval(room, settings).value * 1000),
    ),
    retry: settings.retry,
    diskGuard: settings.diskGuard,
    mail,
    qmsg: { enabled: settings.qmsg?.enabled ?? false, keySet: await services.secretStore.has(QMSG_KEY) },
    douyinCookie: { hasCookie: hasDouyinCookie },
    bilibiliCookie: { hasCookie: hasBilibiliCookie },
    xiaohongshuCookie: { hasCookie: hasXiaohongshuCookie },
    youtubeCookie: {
      hasCookie: await services.secretStore.has(YOUTUBE_COOKIE_KEY),
    },
    theme: settings.theme ?? "system",
    floatingRecorderSize: Math.min(
      100,
      Math.max(20, settings.floatingRecorderSize ?? 36),
    ),
    notifications: notificationPreference(services),
    pipeline: settings.pipeline ?? structuredClone(DEFAULT_SETTINGS.pipeline),
    namingRule: settings.namingRule ?? DEFAULT_SETTINGS.namingRule,
    confirmAfterComplete: settings.confirmAfterComplete ?? false,
    preventSleepWhileRecording: settings.preventSleepWhileRecording ?? true,
    highlightBufferSeconds: settings.highlightBufferSeconds ?? 300,
    highlightEnabled: settings.highlightEnabled ?? true,
    encodingMode: settings.encodingMode ?? "auto",
    danmaku: { enabled: settings.danmaku?.enabled ?? false },
  };
}
