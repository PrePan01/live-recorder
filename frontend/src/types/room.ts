import type { ApiErrorEnvelope } from "./error";
import type { Quality } from "./settings";
import type { Tag } from "./tag";

export type Platform = "bilibili" | "douyin";

export type LiveStatus = "live" | "offline" | "restricted";

export type MonitorState =
  | "idle"
  | "checking"
  | "recording"
  | "reconnecting"
  | "completed"
  | "failed"
  | "disabled";

export type TitleSource = "adapter" | "fallback" | "manual";

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
  liveNotificationEnabled: boolean;
  currentStreamTitle: string | null;
  /** 最近一次检测时该房间实际能录到的清晰度；未开播或平台未给出时为空。 */
  availableQualities: Quality[];
  activeRecording: ActiveRecording | null;
  tags: Tag[];
  uploadEnabled: boolean | null;
  titleSource: TitleSource | null;
  titleUpdatedAt: string | null;
  titleFallbackUsed: boolean;
  sortOrder: number;
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
  liveNotificationEnabled?: boolean;
}

export interface RoomUpdateInput {
  url?: string;
  displayName?: string;
  cookie?: string;
  autoRecord?: boolean | null;
  liveNotificationEnabled?: boolean;
  uploadEnabled?: boolean | null;
}
