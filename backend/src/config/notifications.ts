import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  type NotificationPreference,
} from "../types/settings.js";
import { AppError } from "../types/error.js";

export const NOTIFICATION_CHANNELS = ["desktop", "email", "qq"] as const;
export const NOTIFICATION_KEYS = Object.keys(
  DEFAULT_NOTIFICATION_PREFERENCE.desktop,
) as Array<keyof NotificationPreference["desktop"]>;

/** Normalize both pre-channel and pre-QQ settings without changing stored choices. */
export function normalizeNotifications(input: unknown): NotificationPreference {
  if (
    input !== undefined &&
    input !== null &&
    (typeof input !== "object" || Array.isArray(input))
  )
    throw new AppError("CONFIG_INVALID", "通知偏好必须为对象");
  const raw = (input ?? {}) as Record<string, unknown>;
  const result = structuredClone(DEFAULT_NOTIFICATION_PREFERENCE);
  const legacy =
    !("desktop" in raw) &&
    ("desktopEnabled" in raw || NOTIFICATION_KEYS.some((key) => key in raw));
  for (const channel of NOTIFICATION_CHANNELS) {
    const stored = raw[channel];
    if (
      stored !== undefined &&
      (!stored || typeof stored !== "object" || Array.isArray(stored))
    )
      throw new AppError("CONFIG_INVALID", `${channel} 通知偏好必须为对象`);
    for (const key of NOTIFICATION_KEYS) {
      const value =
        legacy && channel === "desktop"
          ? raw[key]
          : (stored as Record<string, unknown> | undefined)?.[key];
      if (value !== undefined) {
        if (typeof value !== "boolean")
          throw new AppError(
            "CONFIG_INVALID",
            `${channel}.${key} 必须为布尔值`,
          );
        result[channel][key] = value;
      }
      if (legacy && channel === "desktop" && raw.desktopEnabled === false)
        result.desktop[key] = false;
    }
  }
  if (raw.dedupeWindowMinutes !== undefined) {
    if (typeof raw.dedupeWindowMinutes !== "number")
      throw new AppError("CONFIG_INVALID", "重复提醒间隔必须为数值");
    result.dedupeWindowMinutes = raw.dedupeWindowMinutes;
  }
  return result;
}

export function validateNotifications(
  prefs: NotificationPreference,
): AppError | null {
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const key of NOTIFICATION_KEYS) {
      if (typeof prefs[channel]?.[key] !== "boolean")
        return new AppError("CONFIG_INVALID", `${channel}.${key} 必须为布尔值`);
    }
  }
  if (
    !Number.isInteger(prefs.dedupeWindowMinutes) ||
    prefs.dedupeWindowMinutes < 1 ||
    prefs.dedupeWindowMinutes > 1440
  ) {
    return new AppError("CONFIG_INVALID", "重复提醒间隔需为 1-1440 分钟的整数");
  }
  return null;
}
