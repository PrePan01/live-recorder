import type { Platform } from './room';

export type RecordingState = 'pending' | 'recording' | 'reconnecting' | 'completed' | 'failed';

export type Quality = 'original' | '1080p' | '720p' | '360p';

export interface Recording {
  id: string;
  roomId: string;
  platform: Platform;
  streamSessionId: string | null;
  streamTitle: string;
  state: RecordingState;
  startedAt: string;
  endedAt: string | null;
  filePath: string | null;
  fileSizeBytes: number;
  failureReason: ApiFailureReason | null;
  retryCount: number;
  quality: Quality | null;
}

export interface ApiFailureReason {
  code: string;
  message: string;
  occurredAt: string;
  retryable: boolean;
  recordingId?: string;
}

export interface RecordingQuery {
  page?: number;
  pageSize?: number;
  roomId?: string;
  sessionId?: string;
  state?: RecordingState;
  groupBy?: string;
}

export interface PagedRecordings {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
}
