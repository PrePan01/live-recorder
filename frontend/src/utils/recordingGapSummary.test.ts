import { describe, expect, it } from "vitest";
import type { RecordingGap } from "../types/recording";
import { recordingGapSummary } from "./recordingGapSummary";

const gap = (missingMs: number): RecordingGap => ({
  id: String(missingMs),
  startedAt: "2026-10-06T00:00:00Z",
  endedAt: "2026-10-06T00:01:00Z",
  missingMs,
  kind: "stream_disconnect",
  evidence: null,
});

describe("recordingGapSummary", () => {
  it("keeps the 153-second total when legacy details cover only 94 seconds", () => {
    expect(recordingGapSummary(153_000, [gap(31_000), gap(32_000), gap(31_000)]))
      .toEqual({ missingSeconds: 153, unlistedSeconds: 59 });
  });

  it("accounts for the recorded silent tail without an extra discrepancy", () => {
    expect(recordingGapSummary(153_000, [gap(94_000), { ...gap(59_000), kind: "recording_tail" }]))
      .toEqual({ missingSeconds: 153, unlistedSeconds: 0 });
  });

  it("retains totals for old recordings with no gap events", () => {
    expect(recordingGapSummary(59_000, []))
      .toEqual({ missingSeconds: 59, unlistedSeconds: 59 });
  });

  it("subtracts milliseconds before rounding and never shows a negative remainder", () => {
    expect(recordingGapSummary(1500, [gap(1499)]))
      .toEqual({ missingSeconds: 2, unlistedSeconds: 0 });
    expect(recordingGapSummary(1500, [gap(2000)]))
      .toEqual({ missingSeconds: 2, unlistedSeconds: 0 });
  });
});
