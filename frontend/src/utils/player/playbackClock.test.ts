import { describe, expect, it } from "vitest";
import { playbackClock } from "./playbackClock";

describe("playback time labels", () => {
  it.each([
    [-1, "00:00"],
    [0, "00:00"],
    [59.9, "00:59"],
    [60, "01:00"],
    [3599, "59:59"],
    [3600, "01:00:00"],
    [3661, "01:01:01"],
    [360000, "100:00:00"],
  ])(
    "formats %s seconds for timeline and marker labels",
    (seconds, expected) => {
      expect(playbackClock(seconds)).toBe(expected);
    },
  );
  it("preserves total minutes in seek start hints", () => {
    expect(playbackClock(3661.9, false)).toBe("61:01");
  });
});
