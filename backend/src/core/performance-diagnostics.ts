import type { Clock } from "./clock.js";

const MAX_ENTRIES = 100;

export type PerformanceOperationKind = "recording_start" | "preview_start";
export type PerformanceOutcome = "running" | "ok" | "failed" | "skipped";

export interface PerformanceStage {
  name: string;
  elapsedMs: number;
}

export interface PerformanceDiagnostic {
  id: number;
  kind: PerformanceOperationKind;
  roomId: string;
  platform: "bilibili" | "douyin";
  startedAt: string;
  elapsedMs: number;
  outcome: PerformanceOutcome;
  stages: PerformanceStage[];
  /** Stable error category only; do not put URLs, paths, or platform responses here. */
  errorCode: string | null;
}

export interface PerformanceTrace {
  mark(name: string): void;
  finish(
    outcome: Exclude<PerformanceOutcome, "running">,
    errorCode?: string | null,
  ): void;
}

/** Explicitly set by the repository's development launchers; production is off by default. */
export function performanceDiagnosticsEnabled(): boolean {
  return (
    process.env.LIVE_RECORDER_DEVELOPMENT === "1" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  );
}

/** Small, local-only flight recorder for startup latency investigations. */
export class PerformanceDiagnostics {
  readonly enabled: boolean;
  private sequence = 0;
  private entries: PerformanceDiagnostic[] = [];

  constructor(
    private readonly clock: Clock,
    enabled = performanceDiagnosticsEnabled(),
  ) {
    this.enabled = enabled;
  }

  begin(
    kind: PerformanceOperationKind,
    room: { id: string; platform: "bilibili" | "douyin" },
  ): PerformanceTrace {
    if (!this.enabled) return NOOP_TRACE;
    const startedMs = this.clock.now();
    const entry: PerformanceDiagnostic = {
      id: ++this.sequence,
      kind,
      roomId: room.id,
      platform: room.platform,
      startedAt: this.clock.iso(),
      elapsedMs: 0,
      outcome: "running",
      stages: [{ name: "requested", elapsedMs: 0 }],
      errorCode: null,
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    let finished = false;
    const mark = (name: string) => {
      if (finished || entry.stages.some((stage) => stage.name === name)) return;
      entry.stages.push({
        name,
        elapsedMs: Math.max(0, this.clock.now() - startedMs),
      });
      entry.elapsedMs = Math.max(entry.elapsedMs, this.clock.now() - startedMs);
    };
    return {
      mark,
      finish: (outcome, errorCode = null) => {
        if (finished) return;
        mark(outcome === "ok" ? "ready" : outcome);
        entry.elapsedMs = Math.max(0, this.clock.now() - startedMs);
        entry.outcome = outcome;
        entry.errorCode = errorCode;
        finished = true;
      },
    };
  }

  recent(): readonly PerformanceDiagnostic[] {
    if (!this.enabled) return [];
    return this.entries.map((entry) => ({
      ...entry,
      stages: [...entry.stages],
    }));
  }
}

const NOOP_TRACE: PerformanceTrace = {
  mark: () => undefined,
  finish: () => undefined,
};
