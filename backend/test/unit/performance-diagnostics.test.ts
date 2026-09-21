import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { PerformanceDiagnostics } from "../../src/core/performance-diagnostics.js";

describe("PerformanceDiagnostics", () => {
  it("does not retain timing data when disabled for production", () => {
    const diagnostics = new PerformanceDiagnostics(new FakeClock(), false);
    const trace = diagnostics.begin("recording_start", {
      id: "room_private",
      platform: "bilibili",
    });
    trace.mark("stream_url_ready");
    trace.finish("ok");
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.recent()).toEqual([]);
  });
});
