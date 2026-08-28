import type { ErrorObject } from '../types/error.js';
import type { Platform } from '../types/room.js';

export type Quality = 'original' | '1080p' | '720p' | '360p';

export type RecordingState =
  | 'pending'
  | 'recording'
  | 'reconnecting'
  | 'completed'
  | 'failed';

/** 录制文件完整性：verified=ffprobe 校验通过、failed=损坏/截断、pending=校验中或 ffprobe 缺失。 */
export type RecordingIntegrity = 'verified' | 'failed' | 'pending';

export interface Recording {
  id: string;
  roomId: string;
  roomName: string;
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
  createdAt: string;
  quality?: Quality;
  integrity?: RecordingIntegrity;
}
