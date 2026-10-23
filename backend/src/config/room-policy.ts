import type {
  AppSettings,
  EffectiveRoomPolicy,
  EffectiveValue,
  Platform,
  Quality,
  Room,
} from "../types/index.js";
import { AppError } from "../types/error.js";
import {
  CHECK_INTERVAL_MAX_SEC,
  CHECK_INTERVAL_MIN_SEC,
} from "./check-guard.js";

export type RoomPolicySettings = Pick<
  AppSettings,
  "checkIntervalSec" | "quality" | "autoRecord" | "danmaku"
>;

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
  for (const key of [
    "enabled",
    "liveNotificationEnabled",
    "liveEmailNotificationEnabled",
  ] as const) {
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
  settings: Pick<AppSettings, "checkIntervalSec"> | null,
): number {
  const intervals = settings?.checkIntervalSec;
  return (
    intervals?.[platform] ??
    (platform === "xiaohongshu" || platform === "youtube"
      ? 120
      : (intervals?.default ?? (platform === "douyin" ? 120 : 60)))
  );
}

/** 房间检测间隔：执行侧、负载统计与完整策略解析共用此字段解析器。 */
export function resolveCheckInterval(
  room: Pick<Room, "platform" | "checkIntervalSec">,
  settings: Pick<AppSettings, "checkIntervalSec"> | null,
  tagValue?: number | null,
): EffectiveValue<number> {
  return pickPolicyValue(
    room.checkIntervalSec,
    tagValue,
    platformCheckInterval(room.platform, settings),
  );
}

export function roomQuality(
  room: Pick<Room, "quality">,
  settings: Pick<AppSettings, "quality">,
): Quality {
  return pickPolicyValue(room.quality, undefined, settings.quality).value;
}

/**
 * 覆盖优先级的唯一规则：房间显式值 > 标签策略 > 全局默认，来源=最近显式覆盖层。
 * 供各字段绑定与窄签名助手共用，防止任何地方再长出第二份「谁覆盖谁」。
 */
export function pickPolicyValue<T>(
  roomValue: T | null | undefined,
  tagValue: T | null | undefined,
  globalValue: T,
): EffectiveValue<T> {
  if (roomValue !== null && roomValue !== undefined)
    return { value: roomValue, source: "room" };
  if (tagValue !== null && tagValue !== undefined)
    return { value: tagValue, source: "tag" };
  return { value: globalValue, source: "global" };
}

/** 弹幕全局层默认（沿用既有语义：仅显式 true 才默认开）。 */
export function defaultDanmakuEnabled(
  settings: { danmaku?: { enabled: boolean } } | null | undefined,
): boolean {
  return settings?.danmaku?.enabled === true;
}

/** 标签层策略（数据模型尚未落地）：落地后插入房间层与全局层之间即自动生效。 */
export type TagPolicy = Pick<
  RoomPolicyPatch,
  "checkIntervalSec" | "quality" | "autoRecord" | "danmakuEnabled"
>;

/**
 * 继承生效值的唯一出口：房间显式值 > 标签策略 > 全局默认（null/缺省=跟随上层）。
 * 执行侧与接口回传都走这一份规则，前后端不再各算一遍；来源=最近显式覆盖层。
 */
export function resolveRoomPolicy(
  room: Pick<
    Room,
    | "platform"
    | "checkIntervalSec"
    | "quality"
    | "autoRecord"
    | "danmakuEnabled"
  >,
  settings: RoomPolicySettings | null,
  tagPolicy?: TagPolicy | null,
): EffectiveRoomPolicy {
  return {
    checkIntervalSec: resolveCheckInterval(
      room,
      settings,
      tagPolicy?.checkIntervalSec,
    ),
    quality: pickPolicyValue(
      room.quality,
      tagPolicy?.quality,
      settings?.quality ?? "original",
    ),
    autoRecord: pickPolicyValue(
      room.autoRecord,
      tagPolicy?.autoRecord,
      settings?.autoRecord ?? false,
    ),
    danmakuEnabled: pickPolicyValue(
      room.danmakuEnabled,
      tagPolicy?.danmakuEnabled,
      defaultDanmakuEnabled(settings),
    ),
  };
}

/** 弹幕开关生效值：与回传同一规则（收窄签名的调用方走这里，不再自算）。 */
export function resolveDanmakuEnabled(
  room: Pick<Room, "danmakuEnabled">,
  settings: { danmaku?: { enabled: boolean } } | null | undefined,
): boolean {
  return pickPolicyValue(
    room.danmakuEnabled,
    undefined,
    defaultDanmakuEnabled(settings),
  ).value;
}
