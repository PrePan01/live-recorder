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
    expect(
      entries.filter((entry) => entry.room).map((entry) => entry.key),
    ).toEqual(["room-a", "room-b", "room-c"]);
    for (const entry of entries) expect(slots[entry.index]).toBe(entry.room);
  }
});

it("gives every slot its own key when one room repeats (portrait layout)", () => {
  const a = { id: "a" };
  const b = { id: "b" };

  // 3x1 with the same room in slots 0 and 2: duplicate keys would make React
  // reuse the wrong node, so the second occurrence needs a distinct key.
  const entries = stableSlotEntries([a, undefined, a]);
  expect(entries.map((entry) => entry.key)).toEqual([
    "empty-1",
    "room-a",
    "room-a#1",
  ]);
  for (const entry of entries)
    expect([a, undefined, a][entry.index]).toBe(entry.room);

  // Moving the repeat to another slot keeps each room's key stable, so the
  // existing <video> nodes are not remounted.
  const before = stableSlotEntries([a, undefined, a])
    .filter((e) => e.room)
    .map((e) => e.key);
  const after = stableSlotEntries([a, a, undefined])
    .filter((e) => e.room)
    .map((e) => e.key);
  expect(after.slice().sort()).toEqual(before.slice().sort());

  const mixed = stableSlotEntries([b, a, a, a]).map((entry) => entry.key);
  expect(new Set(mixed).size).toBe(mixed.length);
});
