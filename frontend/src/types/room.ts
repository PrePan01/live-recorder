import type { ApiErrorEnvelope } from './error';

export type Platform = 'bilibili' | 'douyin';

export type MonitorState =
  | 'idle'
  | 'checking'
  | 'recording'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'disabled';

export interface Room {
  id: string;
  platform: Platform;
  url: string;
  displayName: string;
  enabled: boolean;
  monitorState: MonitorState;
  lastCheckedAt: string | null;
  lastError: ApiErrorEnvelope | null;
  favorited: boolean;
  activeRecording: ActiveRecording | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRecording {
  recordingId: string;
  startedAt: string;
}

export interface RoomCreateInput {
  platform: Platform;
  url: string;
  displayName?: string;
  cookie?: string;
}

export interface RoomUpdateInput {
  url?: string;
  displayName?: string;
  cookie?: string;
}
