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
  createdAt: string;
  updatedAt: string;
}

export interface RoomCreateInput {
  url: string;
  displayName?: string;
  cookie?: string;
}

export interface RoomUpdateInput {
  url?: string;
  displayName?: string;
  cookie?: string;
}
