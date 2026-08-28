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
  /** 是否单独设置自动录制（v4 P0 #75）：未设置(undefined/null)=继承全局 settings.autoRecord；false=该房间仅检测不自动录。 */
  autoRecord: boolean | null;
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
