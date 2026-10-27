import { describe, expect, it, vi } from "vitest";
import {
  applyRoomBatch,
  DEFAULT_ROOM_POLICY,
  isDefaultPolicy,
  roomPolicy,
} from "./roomPolicy";

describe("restore-default baseline", () => {
  it("shares one baseline with roomPolicy defaults", () => {
    expect(DEFAULT_ROOM_POLICY).toEqual(roomPolicy());
    expect(DEFAULT_ROOM_POLICY).toEqual({
      enabled: true,
      autoRecord: null,
      danmakuEnabled: null,
      liveNotificationEnabled: false,
      checkIntervalSec: null,
      quality: null,
    });
  });
  it("hides restore-default at defaults and shows it on any deviation", () => {
    expect(isDefaultPolicy(roomPolicy())).toBe(true);
    expect(isDefaultPolicy({})).toBe(true);
    const deviations = [
      { enabled: false },
      { autoRecord: true },
      { autoRecord: false },
      { danmakuEnabled: true },
      { liveNotificationEnabled: true },
      { checkIntervalSec: 30 },
      { quality: "720p" as const },
    ];
    for (const patch of deviations) {
      expect(isDefaultPolicy({ ...DEFAULT_ROOM_POLICY, ...patch })).toBe(false);
    }
    // 历史数据房间：任一项落库后又回到默认值即重新视为无覆盖。
    expect(
      isDefaultPolicy({ ...DEFAULT_ROOM_POLICY, quality: null, enabled: true }),
    ).toBe(true);
  });
});

describe("room policies", () => {
  it("normalizes historical room settings", () => {
    expect(roomPolicy()).toEqual({
      enabled: true,
      autoRecord: null,
      danmakuEnabled: null,
      liveNotificationEnabled: false,
      checkIntervalSec: null,
      quality: null,
    });
  });
  it("bounds batch concurrency and retries only failed rooms", async () => {
    let active = 0;
    let maxActive = 0;
    const write = vi.fn(async (id: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (id === "7") throw new Error("failed");
    });
    const ids = Array.from({ length: 20 }, (_, index) => String(index));
    const result = await applyRoomBatch(ids, { quality: null }, write);
    expect(result).toEqual({ succeeded: 19, failed: ["7"] });
    expect(maxActive).toBe(4);
    write.mockResolvedValue(undefined);
    write.mockClear();
    await applyRoomBatch(result.failed, { quality: null }, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("7", { quality: null });
  });
});
