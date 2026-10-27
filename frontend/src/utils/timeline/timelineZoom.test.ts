import { describe, expect, it } from "vitest";
import {
  timelineTicks,
  visibleTimelineLabels,
  zoomTimeline,
} from "./timelineZoom";
import { timelineSecondAt } from "./recordingTimeline";

describe("timeline zoom", () => {
  it("preserves the right-aligned end time when it overlaps a centered tick", () => {
    const visible = visibleTimelineLabels(
      [
        { second: 0, left: 0, right: 32 },
        { second: 7200, left: 721, right: 773 },
        { second: 8100, left: 813, right: 865 },
        { second: 8700, left: 848, right: 900 },
      ],
      8700,
    );
    expect([...visible].sort((a, b) => a - b)).toEqual([0, 7200, 8700]);
  });
  it("retains neighboring labels when their measured widths leave enough space", () => {
    const visible = visibleTimelineLabels(
      [
        { second: 0, left: 0, right: 30 },
        { second: 60, left: 50, right: 80 },
        { second: 120, left: 100, right: 130 },
      ],
      120,
    );
    expect(visible.size).toBe(3);
  });
  it("keeps endpoints and removes multiple crowded labels after a narrow resize", () => {
    const visible = visibleTimelineLabels(
      [
        { second: 0, left: 0, right: 50 },
        { second: 30, left: 32, right: 92 },
        { second: 60, left: 62, right: 122 },
        { second: 100, left: 110, right: 170 },
      ],
      100,
    );
    expect([...visible].sort((a, b) => a - b)).toEqual([0, 100]);
  });
  it("keeps the time under the pointer fixed through zooming and scrolling", () => {
    const width = 800;
    const end = 12 * 3600;
    const pointer = 280;
    const before = { zoom: 4, scrollLeft: 1500 };
    const after = zoomTimeline(
      before.zoom,
      -60,
      width,
      before.scrollLeft,
      pointer,
      end,
    );
    expect((after.scrollLeft + pointer) / after.zoom).toBeCloseTo(
      (before.scrollLeft + pointer) / before.zoom,
    );
    expect(
      timelineSecondAt(
        pointer,
        -after.scrollLeft,
        width * after.zoom,
        end,
        end,
      ),
    ).toBe(
      timelineSecondAt(
        pointer,
        -before.scrollLeft,
        width * before.zoom,
        end,
        end,
      ),
    );
    const restored = zoomTimeline(
      after.zoom,
      60,
      width,
      after.scrollLeft,
      pointer,
      end,
    );
    expect(restored.zoom).toBeCloseTo(before.zoom);
    expect(restored.scrollLeft).toBeCloseTo(before.scrollLeft);
  });
  it("limits zoom and scrolling at both ends, retaining at least ten seconds", () => {
    expect(zoomTimeline(1, 100, 800, 0, 400, 3600)).toEqual({
      zoom: 1,
      scrollLeft: 0,
    });
    expect(zoomTimeline(1, -100, 800, 0, 400, 5)).toEqual({
      zoom: 1,
      scrollLeft: 0,
    });
    const next = zoomTimeline(256, -100, 800, 800 * 255, 800, 3600);
    expect(next.zoom).toBe(360);
    expect(next.scrollLeft).toBe(800 * 359);
    expect(zoomTimeline(1024, -100, 800, 0, 0, 86400).zoom).toBe(1024);
  });
  it("only draws readable ticks around the visible interval of long recordings", () => {
    const end = 24 * 3600;
    const ticks = timelineTicks(end, 128, 42000);
    expect(ticks.length).toBeLessThan(10);
    expect(ticks[0]).toBe(42000);
    expect(ticks[1] - ticks[0]).toBe(120);
    expect(ticks.at(-1)).toBeLessThanOrEqual(42000 + end / 128 + 120);
    expect(timelineTicks(0, 1, 0)).toEqual([]);
  });
});
