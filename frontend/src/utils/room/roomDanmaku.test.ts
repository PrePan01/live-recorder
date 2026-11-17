import { expect, it } from "vitest";
import type { RoomEffectivePolicy } from "../../types/room";
import { roomSavesDanmaku } from "./roomDanmaku";

const effective: RoomEffectivePolicy = {
  danmakuEnabled: { value: false, source: "global" },
  autoRecord: { value: false, source: "global" },
  checkIntervalSec: { value: 60, source: "global" },
  quality: { value: "original", source: "global" },
};

it("honors an explicit room override even when the global setting and effective snapshot disagree", () => {
  expect(roomSavesDanmaku({ danmakuEnabled: true, effective }, false)).toBe(true);
  expect(roomSavesDanmaku({ danmakuEnabled: false }, true)).toBe(false);
});

it("inherits the available room policy or global setting when there is no explicit override", () => {
  expect(roomSavesDanmaku({ danmakuEnabled: null, effective }, true)).toBe(false);
  expect(roomSavesDanmaku({ danmakuEnabled: null }, true)).toBe(true);
  expect(roomSavesDanmaku(undefined, true)).toBe(false);
});
