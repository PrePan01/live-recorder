import type { Platform } from './room';
import type { ApiErrorEnvelope } from './error';


export type RecordingState = 'pending' | 'recording' | 'reconnecting' | 'completed' | 'failed';

export type RecordingIntegrity = 'verified' | 'failed' | 'pending';

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
