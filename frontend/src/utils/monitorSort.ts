import type { Room } from "../types/room";
import type { RoomInsight } from "../api/rooms";

export const MONITOR_SORT_OPTIONS = [
  { value: "manual", label: "按手动排序" },
  { value: "lastRecordedAt", label: "上次录制时间" },
  { value: "lastLiveAt", label: "上次直播时间" },
  { value: "totalDurationMs", label: "录制总时长" },
  { value: "totalRecordings", label: "录制总次数" },
] as const;
export type MonitorSort = (typeof MONITOR_SORT_OPTIONS)[number]["value"];
export function isMonitorSort(value: unknown): value is MonitorSort {
  return MONITOR_SORT_OPTIONS.some((option) => option.value === value);
}

export function sortMonitorRooms(
  rooms: Room[],
  insights: Record<string, RoomInsight>,
  sort: MonitorSort,
): Room[] {
  if (sort === "manual") return rooms;
  const value = (room: Room) => {
    const raw = insights[room.id]?.sorting?.[sort];
    const number = typeof raw === "string" ? Date.parse(raw) : raw;
    return typeof number === "number" && Number.isFinite(number)
      ? number
      : -Infinity;
  };
  return [...rooms].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    return av === bv ? 0 : av > bv ? -1 : 1;
  });
}
