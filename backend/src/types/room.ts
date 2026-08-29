import type { ErrorObject } from './error.js';
import type { Tag } from './tag.js';

export type Platform = 'bilibili' | 'douyin';

export type MonitorState =
  | 'idle'
  | 'checking'
  | 'recording'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'disabled';

/** 最近一次检测的直播状态（#78）：live=开播、offline=未开播、restricted=受限/需更新 Cookie。 */
export type LiveStatus = 'live' | 'offline' | 'restricted';

/** 房间标题来源（V5 #91 扩展）：adapter=平台接口识别、fallback=回退源、manual=手动改名。 */
export type TitleSource = 'adapter' | 'fallback' | 'manual';

export interface Room {
  id: string;
  platform: Platform;
  url: string;
  displayName: string;
  enabled: boolean;
  favorited: boolean;
  /** 是否单独设置自动录制（v4 P0 #75）：未设置(undefined/null)=继承全局 settings.autoRecord；false=该房间仅检测不自动录。 */
  autoRecord: boolean | null;
  /** 最近一次检测的直播状态（#78）：live/offline/restricted，未检测过为 null。 */
  lastLiveStatus: LiveStatus | null;
  monitorState: MonitorState;
  lastCheckedAt: string | null;
  lastError: ErrorObject | null;
  /** 当前录制中的会话信息（未录制为 null），供监控总览显示录制时长。 */
  activeRecording: { recordingId: string; startedAt: string } | null;
  /** V5 标签分组：房间关联的标签（由 RoomTag 关联表解析）。 */
  tags: Tag[];
  /** V5 上传开关：null=继承全局 openlist.enabled；true/false=单独覆盖。 */
  uploadEnabled: boolean | null;
  /** V5 标题识别元数据（#91）：识别来源与时间，供 UI 展示回退/手动状态。 */
  titleSource: TitleSource | null;
  titleUpdatedAt: string | null;
  titleFallbackUsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRecordingInfo {
  recordingId: string;
  startedAt: string;
}
