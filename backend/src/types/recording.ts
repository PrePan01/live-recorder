import type { ErrorObject } from '../types/error.js';
import type { Platform } from '../types/room.js';
import type { UploadJobStatus } from './upload.js';

export type Quality = 'original' | '1080p' | '720p' | '360p';

export type RecordingState =
  | 'pending'
  | 'recording'
  | 'reconnecting'
  | 'processing'
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed';

/** 发起录制的入口；悬浮窗录制完成后始终保留文件。 */
export type RecordingOrigin = 'manual' | 'automatic' | 'floating' | 'highlight';

/**
 * 录制结束原因：区分正常收尾与各类中断。
 * natural=直播结束/下播自然收尾；stopped=手动停止；
 * interrupted=网络中断导致重连耗尽（去重时不算"已录过"，网络恢复后仍可续录）；
 * service_restart=服务重启中断（只标注，不自动续录）。
 */
export type RecordingEndReason = 'natural' | 'stopped' | 'interrupted' | 'service_restart';

/** 录制文件完整性：verified=ffprobe 校验通过、failed=损坏/截断、pending=校验中或 ffprobe 缺失。 */
export type RecordingIntegrity = 'verified' | 'failed' | 'pending';

/** 后处理管线状态（V5）：not_required=未启用管线、queued=排队中、running=处理中、ok=成功、partial=部分成功、failed=失败。 */
export type PipelineStatus = 'not_required' | 'queued' | 'running' | 'ok' | 'partial' | 'failed';

/** 后处理 sidecar 元数据（V5）：录制完成后由管线写入，供历史页展示真实时长/断流次数/清晰度/大小。 */
export interface RecordingMetadata {
  durationMs: number | null;
  segmentCount: number;
  quality: string | null;
  size: number;
}

export interface Recording {
  id: string;
  roomId: string;
  roomName: string;
  platform: Platform;
  streamSessionId: string | null;
  streamTitle: string;
  state: RecordingState;
  startedAt: string;
  endedAt: string | null;
  filePath: string | null;
  fileSizeBytes: number;
  failureReason: ErrorObject | null;
  retryCount: number;
  createdAt: string;
  origin?: RecordingOrigin;
  quality?: Quality;
  /** 录制发起时设置的期望画质（settings.quality 快照），用于历史页判断是否发生画质回退——不依赖当前设置（PrePan：当前设置不应影响已录制记录）。 */
  expectedQuality?: Quality;
  integrity?: RecordingIntegrity;
  /** V5 后处理管线状态（未参与管线时缺省）。 */
  pipelineStatus?: PipelineStatus;
  /** V5 后处理 sidecar 元数据（真实时长/片段数/清晰度/大小）。 */
  metadata?: RecordingMetadata;
  /** V5 封面帧路径（可选，媒体封面占位 404）。 */
  coverPath?: string;
  /** V5 最近上传任务快照（历史页上传状态列，无任务时缺省）。 */
  upload?: { status: UploadJobStatus; progress: number; remotePath: string | null; error: string | null };
  /** 结束原因（录制收尾时写入；进行中的录制缺省）。 */
  endReason?: RecordingEndReason;
  /** 录制中途累计缺失时长（毫秒）：中断恢复后未录到的时间总和，历史页标注"中途缺失 N 秒"。 */
  missingMs?: number;
  /** 精彩时刻缓存正在导出。仅用于让确认弹窗可提前出现时安全恢复状态。 */
  highlightExportPending?: boolean;
  /** 导出尚未结束时用户已提交的保留决定；null 代表尚未决定。 */
  highlightConfirmationDecision?: boolean | null;
  highlightConfirmationFileName?: string | null;
}
