import type { Platform } from './room';
import type { ApiErrorEnvelope } from './error';


export type RecordingState = 'pending' | 'recording' | 'reconnecting' | 'awaiting_confirmation' | 'processing' | 'completed' | 'failed';

export type RecordingIntegrity = 'verified' | 'failed' | 'pending';

export type PipelineStatus = 'not_required' | 'queued' | 'running' | 'ok' | 'partial' | 'failed';

export type UploadSnapshotStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

export interface UploadSnapshot {
  status: UploadSnapshotStatus;
  progress: number;
  remotePath: string | null;
  error: string | null;
}

export interface PipelineMetadata {
  durationMs: number;
  segmentCount: number;
  quality: string;
  size: number;
}

export interface Recording {
  id: string;
  roomId: string;
  roomName: string;
  platform: Platform;
  streamSessionId: string | null;
  streamTitle: string;
  quality: string | null;
  integrity: RecordingIntegrity | null;
  state: RecordingState;
  pipelineStatus: PipelineStatus | null;
  upload: UploadSnapshot | null;
  metadata: PipelineMetadata | null;
  coverPath: string | null;
  startedAt: string;
  endedAt: string | null;
  filePath: string | null;
  fileSizeBytes: number;
  failureReason: ApiErrorEnvelope | null;
  retryCount: number;
}

export interface RecordingQuery {
  page?: number;
  pageSize?: number;
  roomId?: string;
  sessionId?: string;
  state?: RecordingState;
  groupBy?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PagedRecordings {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
}
