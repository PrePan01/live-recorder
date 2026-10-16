import type { ApiErrorEnvelope } from "./error";
import type { Quality } from "./settings";
import type { Tag } from "./tag";

export type Platform = "bilibili" | "douyin" | "xiaohongshu";

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
  liveRoomUrl?: string;
  displayName: string;
  checkIntervalSec?: number | null;
  quality?: Quality | null;
  danmakuEnabled?: boolean | null;
  enabled: boolean;
  monitorState: MonitorState;
  lastLiveStatus: LiveStatus | null;
  lastCheckedAt: string | null;
  lastError: ApiErrorEnvelope | null;
  favorited: boolean;
  autoRecord: boolean | null;
  /** 是否订阅开播提醒；桌面和邮件渠道由全局通知偏好决定。 */
  liveNotificationEnabled: boolean;
  /** 历史字段，仅兼容旧数据，不参与通知控制。 */
  liveEmailNotificationEnabled?: boolean;
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
  /** 主播头像地址（历史/未抓到时缺省，前端降级首字展示；BE 检测周期顺带刷新）。 */
  liveCoverUrl?: string | null;
  avatarUrl?: string | null;
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
  enabled?: boolean;
  autoRecord?: boolean | null;
  danmakuEnabled?: boolean | null;
  checkIntervalSec?: number | null;
  quality?: Quality | null;
  liveNotificationEnabled?: boolean;
  liveEmailNotificationEnabled?: boolean;
}

export interface RoomUpdateInput {
  enabled?: boolean;
  checkIntervalSec?: number | null;
  quality?: Quality | null;
  url?: string;
  displayName?: string;
  cookie?: string;
  autoRecord?: boolean | null;
  liveNotificationEnabled?: boolean;
  liveEmailNotificationEnabled?: boolean;
  uploadEnabled?: boolean | null;
  danmakuEnabled?: boolean | null;
}
