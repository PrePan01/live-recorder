// task #57/#58：新增 audio 步（管线自动导出音频，segment 后 compress 前，吃源文件）
export type PipelineStep = 'verify' | 'sidecar' | 'cover' | 'segment' | 'audio' | 'compress' | 'archive';

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
  /** 导出音频文件开关（task #57/#58）：默认关，只影响之后触发的 run（启动时快照） */
  exportAudio: boolean;
}