export type PipelineStep =
  | "verify"
  | "sidecar"
  | "cover"
  | "segment"
  | "audio"
  | "convert"
  | "compress"
  | "archive";

export type PipelineRunStatus =
  "queued" | "running" | "ok" | "partial" | "failed";

export type PipelineArtifactStatus =
  "queued" | "running" | "ok" | "failed" | "skipped";

export interface PipelineArtifact {
  id: string;
  runId: string;
  step: PipelineStep;
  status: PipelineArtifactStatus;
  path: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  actualEncoder: string | null;
  fallbackReason: string | null;
}

export interface PipelineRun {
  id: string;
  recordingId: string;
  status: PipelineRunStatus;
  progressStep?: string | null;
  progressPct?: number | null;
  heartbeatAt?: string | null;
  etaSeconds?: number | null;
  configSnapshot: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  artifacts: PipelineArtifact[];
}

/** 管线详情（API 输出）：run + artifacts 扁平视图。 */
export interface PipelineRunView {
  run: Omit<PipelineRun, "artifacts">;
  artifacts: PipelineArtifact[];
}
