import { describe, expect, it } from "vitest";
import type { Room } from "../types/room";
import { reorderVisibleRooms } from "./roomOrder";

const rooms = (...ids: string[]) => ids.map((id) => ({ id }) as Room);
const ids = (items: Room[]) => items.map((room) => room.id);

describe("reorderVisibleRooms", () => {
  it("inserts both forward and backward", () => {
    expect(
      ids(
        reorderVisibleRooms(
          rooms("a", "b", "c", "d"),
          ["a", "b", "c", "d"],
          "a",
          "c",
          "after",
        ),
      ),
    ).toEqual(["b", "c", "a", "d"]);
    expect(
      ids(
        reorderVisibleRooms(
          rooms("a", "b", "c", "d"),
          ["a", "b", "c", "d"],
          "d",
          "b",
          "before",
        ),
      ),
    ).toEqual(["a", "d", "b", "c"]);
  });

  it("reorders visible slots while hidden rooms keep their relative order", () => {
    const next = reorderVisibleRooms(
      rooms("hidden-1", "a", "hidden-2", "b", "c"),
      ["a", "b", "c"],
      "c",
      "a",
      "before",
    );
    expect(ids(next)).toEqual(["hidden-1", "c", "hidden-2", "a", "b"]);
  });

  it("returns the original array for no-op and stale inputs", () => {
    const all = rooms("a", "b", "c");
    expect(reorderVisibleRooms(all, ["a", "b"], "a", "a", "before")).toBe(all);
    expect(
      reorderVisibleRooms(all, ["a", "missing"], "a", "missing", "before"),
    ).toBe(all);
    expect(reorderVisibleRooms(all, ["a", "a"], "a", "b", "before")).toBe(all);
  });
});
