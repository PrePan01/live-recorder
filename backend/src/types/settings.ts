import type { Quality } from './recording.js';

export interface RetryConfig {
  maxAttempts: number;
  delaysSeconds: number[];
}

export interface DiskGuardConfig {
  minFreeBytes: number;
  minFreePercent: number;
}

export interface CheckIntervalSec {
  default: number;
  bilibili: number;
  douyin: number;
}

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  recipients: string[];
}

/** 输出视图：不回显密码，仅 passwordSet 派生标记（SecretStore 中是否存在键）。 */
export interface MailConfigView extends MailConfig {
  passwordSet: boolean;
}

/** 录制文件格式：source_flv=源 FLV 直写（.flv，无损最快）；mp4_after=完成后 ffmpeg 转封装 MP4。 */
export type RecordingFormat = 'source_flv' | 'mp4_after';

/** 界面主题（V5）：light=浅色、dark=深色、system=跟随系统；随 settings 读写。 */
export type ThemePreference = 'light' | 'dark' | 'system';

export interface AppSettings {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  /** 录制默认清晰度（阶段 C 生效）；recordings.quality 内部列记录实际使用值。 */
  quality: Quality;
  /** 录制格式（v4）：source_flv 直写或完成后转 MP4。 */
  recordingFormat: RecordingFormat;
  /** 检测到开播时是否自动录制（v4，#63）：默认 true；false=仅检测不自动录。 */
  autoRecord: boolean;
  checkIntervalSec: CheckIntervalSec;
  retry: RetryConfig;
  diskGuard: DiskGuardConfig;
  mail: MailConfig;
  /** 邮件去重窗口 v1 固定 30 分钟，不暴露到 /settings。 */
  dedupeWindowMinutes: number;
  /** V5 界面主题偏好（FE 持久化经此字段）；缺省 system。 */
  theme: ThemePreference;
  /** V5 通知偏好（开播/录制/磁盘事件预设+开关）。 */
  notifications?: NotificationPreference;
  /** V5 后处理管线配置（Batch2 主干基建；P0 阶段先立契约与默认值）。 */
  pipeline?: PipelineConfig;
}

/** V5 通知偏好：各事件开关 + 去重窗口；邮件 SMTP 配置仍走 mail（mail.enabled 生效时才发邮件）。 */
export interface NotificationPreference {
  /** 桌面/系统通知总开关（FE 侧经 Tauri 通知；BE 持久化偏好）。 */
  desktopEnabled: boolean;
  /** 开播提醒：直播检测到开播时通知。 */
  liveStarted: boolean;
  /** 录制开始提醒。 */
  recordingStarted: boolean;
  /** 录制结束提醒。 */
  recordingEnded: boolean;
  /** 录制失败提醒。 */
  recordingFailed: boolean;
  /** 磁盘空间不足提醒。 */
  diskSpaceLow: boolean;
  /** 上传失败提醒（OpenList 等）。 */
  uploadFailed: boolean;
  /** 去重窗口（分钟）：同房间同类事件在该窗口内只发一次。 */
  dedupeWindowMinutes: number;
}

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  desktopEnabled: true,
  liveStarted: true,
  recordingStarted: true,
  recordingEnded: false,
  recordingFailed: true,
  diskSpaceLow: true,
  uploadFailed: true,
  dedupeWindowMinutes: 30,
};

/** V5 后处理管线配置（写入 settings 扩展，管线仅消费显式启用的开关）。 */
export interface PipelineConfig {
  /** 总开关：false 时录制完成不进管线（等价 not_required）。 */
  enabled: boolean;
  /** ffprobe 完整性校验。 */
  verify: boolean;
  /** 配置化切片（秒）；0/缺省=不切片。 */
  segmentSeconds: number;
  /** 可选压缩（-crf）；null/缺省=不压缩。 */
  crf: number | null;
  /** 归档目录；空=不归档。 */
  archiveDirectory: string;
  /** 管线并发上限（V5 定 N=2，录制主链路优先）。 */
  maxConcurrency: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: false,
  verify: true,
  segmentSeconds: 0,
  crf: null,
  archiveDirectory: '',
  maxConcurrency: 2,
};

export interface SettingsView {
  recordingDirectory: string;
  maxConcurrentRecordings: number;
  quality: Quality;
  recordingFormat: RecordingFormat;
  autoRecord: boolean;
  checkIntervalSec: CheckIntervalSec;
  retry: RetryConfig;
  diskGuard: DiskGuardConfig;
  mail: MailConfigView;
  /** v1.3：抖音 Cookie 是否已配置（值存 SecretStore，不落盘、不回显）。 */
  douyinCookie: { hasCookie: boolean };
  /** V5 界面主题偏好。 */
  theme: ThemePreference;
  /** V5 通知偏好视图（与写入契约一致）。 */
  notifications?: NotificationPreference;
  /** V5 后处理管线配置视图（与写入契约一致）。 */
  pipeline?: PipelineConfig;
}
