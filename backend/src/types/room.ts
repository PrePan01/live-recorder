import type { ErrorObject } from './error.js';

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
  lastError: ErrorObject | null;
  createdAt: string;
  updatedAt: string;
}
