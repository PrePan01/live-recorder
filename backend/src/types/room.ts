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
  favorited: boolean;
  monitorState: MonitorState;
  lastCheckedAt: string | null;
  lastError: ErrorObject | null;
  /** 当前录制中的会话信息（未录制为 null），供监控总览显示录制时长。 */
  activeRecording: { recordingId: string; startedAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRecordingInfo {
  recordingId: string;
  startedAt: string;
}
