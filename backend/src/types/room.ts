import type { ErrorObject } from './error.js';
import type { Quality } from './recording.js';
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

/** 房间标题来源（V5 #91 扩展）：adapter=平台接口识别、fallback=回退源、manual=手动改名、placeholder=安全占位（#128）。 */
export type TitleSource = 'adapter' | 'fallback' | 'manual' | 'placeholder';

export interface Room {
  id: string;
  platform: Platform;
  url: string;
  displayName: string;
  /** 主播头像 CDN 地址（平台检测周期顺带写入，历史房间可能为 null；UI 需兑底）。 */
  avatarUrl: string | null;
  enabled: boolean;
  favorited: boolean;
  /** 是否单独设置自动录制（v4 P0 #75）：未设置(undefined/null)=继承全局 settings.autoRecord；false=该房间仅检测不自动录。 */
  autoRecord: boolean | null;
  /** 是否在该直播间离线转开播时发送桌面提醒；默认关闭。 */
  liveNotificationEnabled: boolean;
  /** 最近一次检测的直播状态（#78）：live/offline/restricted，未检测过为 null。 */
  lastLiveStatus: LiveStatus | null;
  /** 当前已确认开播周期的本地起点；下播后清空。自动录制去重只在此周期内生效。 */
  liveStartedAt: string | null;
  /** 本开播周期内已被用户手动停止：自动录制在本场内跳过，下播（offline 清 liveStartedAt 同时清本标记）后下一场恢复。 */
  autoRecordStoppedSession?: string | null;
  /** 最近一次检测到的当前直播间标题；仅在开播时保留。 */
  currentStreamTitle: string | null;
  /**
   * 最近一次检测时该房间实际能录到的清晰度（平台按账号登录态/房间权限给出）。
   * 用于在录制前就告知用户「最高只能录到多少」——未登录 B站 时平台只给低清晰度，
   * 不提前说明的话用户会以为按设置录制，录完才发现画质不符。未开播时为空。
   */
  availableQualities: Quality[];
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
  /** 用户维护的全局展示顺序，数值越小越靠前。 */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRecordingInfo {
  recordingId: string;
  startedAt: string;
}
