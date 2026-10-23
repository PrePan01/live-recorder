import type { AppSettings, Platform, Quality, Room } from "../types/index.js";
import { AppError } from "../types/error.js";
import {
  CHECK_INTERVAL_MAX_SEC,
  CHECK_INTERVAL_MIN_SEC,
} from "./check-guard.js";

export type RoomPolicyPatch = Partial<
  Pick<
    Room,
    | "enabled"
    | "autoRecord"
    | "danmakuEnabled"
    | "liveNotificationEnabled"
    | "liveEmailNotificationEnabled"
    | "checkIntervalSec"
    | "quality"
  >
>;

/** Shared by room creation, edits and backup restoration. Omitted keys stay omitted. */
export function validateRoomPolicy(
  input: Record<string, unknown>,
): RoomPolicyPatch {
  const patch: RoomPolicyPatch = {};
  for (const key of ["enabled", "liveNotificationEnabled", "liveEmailNotificationEnabled"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean")
      throw new AppError("ROOM_LINK_INVALID", `${key} 必须为布尔值`);
    patch[key] = input[key];
  }
  for (const key of ["autoRecord", "danmakuEnabled"] as const) {
    if (input[key] === undefined) continue;
    if (input[key] !== null && typeof input[key] !== "boolean")
      throw new AppError("ROOM_LINK_INVALID", `${key} 必须为布尔值或 null`);
    patch[key] = input[key] as boolean | null;
  }
  const interval = input.checkIntervalSec;
  if (interval !== undefined) {
    if (
      interval !== null &&
      (typeof interval !== "number" ||
        !Number.isSafeInteger(interval) ||
        interval < CHECK_INTERVAL_MIN_SEC ||
        interval > CHECK_INTERVAL_MAX_SEC)
    )
      throw new AppError(
        "CONFIG_INVALID",
        `检测间隔需为 ${CHECK_INTERVAL_MIN_SEC}~${CHECK_INTERVAL_MAX_SEC} 秒的安全整数或 null`,
      );
    patch.checkIntervalSec = interval as number | null;
  }
  const quality = input.quality;
  if (quality !== undefined) {
    if (
      quality !== null &&
      !["original", "1080p", "720p", "540p", "360p"].includes(quality as string)
    )
      throw new AppError(
        "CONFIG_INVALID",
        "录制清晰度需为 original / 1080p / 720p / 540p / 360p 或 null",
      );
    patch.quality = quality as Quality | null;
  }
  return patch;
}

export function platformCheckInterval(
  platform: Platform,
  settings: AppSettings | null,
): number {
  const intervals = settings?.checkIntervalSec;
  return (
    intervals?.[platform] ??
    ((platform === "xiaohongshu" || platform === "youtube")
      ? 120
      : (intervals?.default ?? (platform === "douyin" ? 120 : 60)))
  );
}

export function roomQuality(
  room: Pick<Room, "quality">,
  settings: AppSettings,
): Quality {
  return room.quality ?? settings.quality;
}
