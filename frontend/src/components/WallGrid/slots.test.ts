import { expect, it } from "vitest";
import { stableSlotEntries } from "./slots";

it("keeps video DOM order stable across repeated swaps and moves to empty slots", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  const layouts = [
    [a, b, c, undefined],
    [c, b, a, undefined],
    [undefined, b, a, c],
    [b, undefined, c, a],
    [a, b, c, undefined],
  ];
  for (const slots of layouts) {
    const entries = stableSlotEntries(slots);
    expect(entries.filter((entry) => entry.room).map((entry) => entry.key))
      .toEqual(["room-a", "room-b", "room-c"]);
    for (const entry of entries) expect(slots[entry.index]).toBe(entry.room);
  }
});
