import type { ApiErrorEnvelope } from './error';
import type { Tag } from './tag';

export type Platform = 'bilibili' | 'douyin';

export type LiveStatus = 'live' | 'offline' | 'restricted';

export type MonitorState =
  | 'idle'
  | 'checking'
  | 'recording'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'disabled';

export type TitleSource = 'adapter' | 'fallback' | 'manual';

export interface Room {
  id: string;
  platform: Platform;
  url: string;
  displayName: string;
  enabled: boolean;
  monitorState: MonitorState;
  lastLiveStatus: LiveStatus | null;
  lastCheckedAt: string | null;
  lastError: ApiErrorEnvelope | null;
  favorited: boolean;
  autoRecord: boolean | null;
  activeRecording: ActiveRecording | null;
  tags: Tag[];
  uploadEnabled: boolean | null;
  titleSource: TitleSource | null;
  titleUpdatedAt: string | null;
  titleFallbackUsed: boolean;
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
  autoRecord?: boolean | null;
  uploadEnabled?: boolean | null;
}
