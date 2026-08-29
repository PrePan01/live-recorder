export type PipelineStep = 'verify' | 'sidecar' | 'cover' | 'segment' | 'compress' | 'archive';

export type PipelineRunStatus = 'queued' | 'running' | 'ok' | 'partial' | 'failed';

export type PipelineArtifactStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped';

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
}

export interface PipelineRun {
  id: string;
  recordingId: string;
  status: PipelineRunStatus;
  configSnapshot: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  artifacts: PipelineArtifact[];
}

export interface PipelineRunDetail {
  run: Omit<PipelineRun, 'artifacts'> | null;
  artifacts: PipelineArtifact[];
}

export interface PipelineConfig {
  enabled: boolean;
  verify: boolean;
  segmentSeconds: number;
  crf: number | null;
  archiveDirectory: string;
  maxConcurrency: number;
}