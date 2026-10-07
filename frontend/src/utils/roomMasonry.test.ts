import { describe, expect, it } from "vitest";
import { layoutRoomMasonry } from "./roomMasonry";

describe("room masonry", () => {
  it("fills the shortest column instead of leaving gaps below short cards", () => {
    expect(
      layoutRoomMasonry([400, 200, 300, 100, 150], 3, 300, 16),
    ).toMatchObject({
      positions: [
        { left: 0, top: 0 },
        { left: 316, top: 0 },
        { left: 632, top: 0 },
        { left: 316, top: 216 },
        { left: 632, top: 316 },
      ],
      height: 466,
    });
  });
  it("handles one column, empty rooms and resized card heights", () => {
    expect(layoutRoomMasonry([], 4, 200, 16).height).toBe(0);
    expect(layoutRoomMasonry([100, 180], 1, 320, 16)).toMatchObject({
      positions: [
        { left: 0, top: 0 },
        { left: 0, top: 116 },
      ],
      height: 296,
    });
    expect(layoutRoomMasonry([500, 200, 100], 2, 200, 16).positions[2]).toEqual(
      { left: 216, top: 216 },
    );
  });
  it("keeps columns when hover grows a card and only moves following rooms in that column", () => {
    const initial = layoutRoomMasonry(
      [200, 220, 180, 120, 140, 160],
      3,
      300,
      16,
      20,
    );
    const expanded = layoutRoomMasonry(
      [240, 220, 180, 120, 140, 160],
      3,
      300,
      16,
      20,
      initial.columnAssignments,
    );
    expect(expanded.columnAssignments).toEqual(initial.columnAssignments);
    expect(expanded.positions.map((position) => position.left)).toEqual(
      initial.positions.map((position) => position.left),
    );
    expect(
      expanded.positions.map(
        (position, index) => position.top - initial.positions[index].top,
      ),
    ).toEqual([0, 0, 0, 0, 40, 0]);
    expect(
      layoutRoomMasonry(
        [200, 220, 180, 120, 140, 160],
        3,
        300,
        16,
        20,
        initial.columnAssignments,
      ).positions,
    ).toEqual(initial.positions);
  });
});
