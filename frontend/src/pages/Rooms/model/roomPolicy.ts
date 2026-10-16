import type { Room, RoomUpdateInput, Platform } from "../../../types/room";
import type { Settings } from "../../../types/settings";

export type RoomPolicy = Pick<
  RoomUpdateInput,
  | "enabled"
  | "autoRecord"
  | "danmakuEnabled"
  | "liveNotificationEnabled"
  | "checkIntervalSec"
  | "quality"
>;
export const QUALITY_OPTIONS = [
  { value: "original", label: "原画" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "360p", label: "360p" },
];
export function inheritedInterval(
  platform: Platform | undefined,
  settings: Settings | null,
): number {
  return (
    (platform ? settings?.checkIntervalSec[platform] : undefined) ??
    (platform === "xiaohongshu"
      ? 120
      : (settings?.checkIntervalSec.default ??
        (platform === "douyin" ? 120 : 60)))
  );
}
export function roomPolicy(room?: Partial<Room>): RoomPolicy {
  return {
    enabled: room?.enabled ?? true,
    autoRecord: room?.autoRecord ?? null,
    danmakuEnabled: room?.danmakuEnabled ?? null,
    liveNotificationEnabled: room?.liveNotificationEnabled ?? false,
    checkIntervalSec: room?.checkIntervalSec ?? null,
    quality: room?.quality ?? null,
  };
}

/** 默认策略=全部跟随全局，取自 roomPolicy() 无参形态，恢复默认与显隐判定共用此基准。 */
export const DEFAULT_ROOM_POLICY: RoomPolicy = roomPolicy();

/** 任一策略项偏离默认即视为有覆盖；缺省字段按默认计。 */
export function isDefaultPolicy(policy: RoomPolicy): boolean {
  const normalized = roomPolicy(policy);
  return (Object.keys(DEFAULT_ROOM_POLICY) as (keyof RoomPolicy)[]).every(
    (key) => normalized[key] === DEFAULT_ROOM_POLICY[key],
  );
}

/** Bounded writes with a stable target snapshot; a retry only receives failed IDs. */
export async function applyRoomBatch(
  ids: string[],
  patch: RoomPolicy,
  write: (id: string, patch: RoomPolicy) => Promise<void>,
) {
  const failed: string[] = [];
  let cursor = 0;
  let succeeded = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          await write(id, patch);
          succeeded += 1;
        } catch {
          failed.push(id);
        }
      }
    }),
  );
  return { succeeded, failed };
}
