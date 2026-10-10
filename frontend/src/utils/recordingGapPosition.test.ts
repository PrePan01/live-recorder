import { describe, expect, it } from "vitest";
import type { RecordingGap } from "../types/recording";
import { recordingGapPosition } from "./recordingGapPosition";

const start = "2026-10-06T00:00:00Z";
const gap = (patch: Partial<RecordingGap> = {}): RecordingGap => ({
  id: "gap-1",
  startedAt: "2026-10-06T01:23:45Z",
  endedAt: "2026-10-06T01:24:16Z",
  missingMs: 31_000,
  kind: "stream_disconnect",
  evidence: null,
  ...patch,
});

describe("recordingGapPosition", () => {
  it("uses the saved media position rather than wall-clock elapsed time", () => {
    const current = gap({ evidence: '{"mediaPositionMs":3723999}' });
    expect(recordingGapPosition(current, [current], start)).toBe("01:02:03");
  });

  it("estimates old positions after subtracting all previous gaps even when unsorted", () => {
    const current = gap();
    const previous = gap({ id: "earlier", startedAt: "2026-10-06T00:10:00Z", endedAt: "2026-10-06T00:11:00Z", missingMs: 60_000 });
    const later = gap({ id: "later", startedAt: "2026-10-06T02:00:00Z", endedAt: "2026-10-06T02:01:00Z", missingMs: 60_000 });
    expect(recordingGapPosition(current, [later, current, previous], start)).toBe("约 01:22:45");
  });

  it("formats zero and more than 24 hours without wrapping", () => {
    expect(recordingGapPosition(gap({ evidence: '{"mediaPositionMs":0}' }), [], start)).toBe("00:00:00");
    expect(recordingGapPosition(gap({ evidence: '{"mediaPositionMs":90061000}' }), [], start)).toBe("25:01:01");
  });

  it.each(["bad JSON", "null", '{"mediaPositionMs":-1}', '{"mediaPositionMs":"1234"}'])
    ("falls back safely for unusable evidence: %s", (evidence) => {
      expect(recordingGapPosition(gap({ evidence }), [], start)).toBe("约 01:23:45");
    });

  it("handles missing dates and clamps negative estimates", () => {
    expect(recordingGapPosition(gap(), [], "bad date")).toBeNull();
    expect(recordingGapPosition(gap({ startedAt: "bad date" }), [], start)).toBeNull();
    expect(recordingGapPosition(gap({ startedAt: "2026-10-05T00:00:00Z" }), [], start)).toBe("约 00:00:00");
  });
});
