import type { ErrorObject } from '../types/error.js';
import type { Platform } from '../types/room.js';

export type Quality = 'original' | '1080p' | '720p' | '360p';

export type RecordingState =
  | 'pending'
  | 'recording'
  | 'reconnecting'
  | 'completed'
  | 'failed';

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
  failureReason: ErrorObject | null;
  retryCount: number;
  quality: Quality | null;
  createdAt: string;
}
