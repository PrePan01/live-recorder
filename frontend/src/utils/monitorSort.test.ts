import { describe, expect, it } from "vitest";
import type { Room } from "../types/room";
import type { RoomInsight } from "../api/rooms";
import {
  isMonitorSort,
  sortMonitorRooms,
  type MonitorSort,
} from "./monitorSort";

const rooms = ["a", "b", "c", "missing"].map((id) => ({ id }) as Room);
const insights = {
  a: {
    sorting: {
      lastRecordedAt: "2026-10-01T12:00:00Z",
      lastLiveAt: null,
      totalDurationMs: 100,
      totalRecordings: 2,
    },
  },
  b: {
    sorting: {
      lastRecordedAt: "2026-10-02T12:00:00Z",
      lastLiveAt: "2026-10-01T12:00:00Z",
      totalDurationMs: 500,
      totalRecordings: 1,
    },
  },
  c: {
    sorting: {
      lastRecordedAt: "2026-10-01T12:00:00Z",
      lastLiveAt: "2026-10-02T12:00:00Z",
      totalDurationMs: 100,
      totalRecordings: 3,
    },
  },
} as unknown as Record<string, RoomInsight>;

describe("monitor sort", () => {
  it.each<[MonitorSort, string[]]>([
    ["lastRecordedAt", ["b", "a", "c", "missing"]],
    ["lastLiveAt", ["c", "b", "a", "missing"]],
    ["totalDurationMs", ["b", "a", "c", "missing"]],
    ["totalRecordings", ["c", "a", "b", "missing"]],
  ])(
    "sorts %s descending, retaining manual order for ties and missing history",
    (mode, ids) => {
      expect(
        sortMonitorRooms(rooms, insights, mode).map((room) => room.id),
      ).toEqual(ids);
      expect(rooms.map((room) => room.id)).toEqual(["a", "b", "c", "missing"]);
    },
  );
  it("preserves manual order and falls back while metrics are unavailable", () => {
    expect(sortMonitorRooms(rooms, insights, "manual")).toBe(rooms);
    expect(sortMonitorRooms(rooms, {}, "lastRecordedAt")).toEqual(rooms);
    expect(isMonitorSort("lastLiveAt")).toBe(true);
    expect(isMonitorSort("invalid")).toBe(false);
  });
});
