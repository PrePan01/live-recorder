import type { Platform } from "./room";
import type { ApiErrorEnvelope } from "./error";

export type RecordingState =
  | "pending"
  | "recording"
  | "reconnecting"
  | "awaiting_confirmation"
  | "processing"
  | "completed"
  | "failed";

export type RecordingIntegrity = "verified" | "failed" | "pending";

export type RecordingIntegrityState =
  "pending" | "queued" | "verifying" | "ok" | "failed" | "unverifiable";

/**
 * 录制结束原因：natural=直播结束自然收尾、stopped=手动停止、
 * interrupted=中断（网络/写盘）停止、service_restart=服务重启中断。
 */
export type RecordingEndReason =
  "natural" | "stopped" | "interrupted" | "service_restart" | "clip_export";

export type PipelineStatus =
  "not_required" | "queued" | "running" | "ok" | "partial" | "failed";

export type UploadSnapshotStatus =
  "queued" | "running" | "ok" | "failed" | "cancelled";

export interface UploadSnapshot {
  status: UploadSnapshotStatus;
  progress: number;
  remotePath: string | null;
  error: string | null;
  /** 上传任务最后更新时间（verifying 等待计时基准，避免用录制结束时间误导）。 */
  updatedAt?: string | null;
}

export interface PipelineMetadata {
  durationMs: number;
  segmentCount: number;
  quality: string;
  size: number;
}

export interface RecordingGap {
  id: string;
  startedAt: string;
  endedAt: string;
  missingMs: number;
  /** 归因分类：服务重启/控制重连/流断档/写盘异常等，取值由服务端判定。 */
  kind: string;
  evidence: string | null;
}

export interface RecordingMarker {
  id: string;
  recordingId: string;
  positionSeconds: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface Recording {
  id: string;
  origin?: "manual" | "automatic" | "floating" | "highlight" | "clip";
  roomId: string;
  roomName: string;
  platform: Platform;
  streamSessionId: string | null;
  streamTitle: string;
  quality: string | null;
  /** 录制发起时的期望画质快照，历史页据此判断画质回退（不依赖当前设置）。 */
  expectedQuality: string | null;
  integrity: RecordingIntegrity | null;
  /** 校验细分态：缺省=旧数据，展示层回退旧三态。 */
  integrityState?: RecordingIntegrityState;
  integrityAttempts?: number;
  integrityLastAttempt?: string;
  integrityError?: string | null;
  verifyQueuePosition?: number | null;
  /** 中断次数（与 missingMs 同口径聚合；缺省=旧数据只显秒数）。 */
  gapCount?: number;
  state: RecordingState;
  pipelineStatus: PipelineStatus | null;
  upload: UploadSnapshot | null;
  metadata: PipelineMetadata | null;
  coverPath: string | null;
  startedAt: string;
  endedAt: string | null;
  filePath: string | null;
  fileSizeBytes: number;
  failureReason: ApiErrorEnvelope | null;
  retryCount: number;
  systemSleepInterrupted?: boolean;
  /** 片段导出进行中的进度百分比（0-100）；无后台导出或终态时为空。 */
  progressPercent?: number | null;
  hasDanmaku?: boolean;
  danmakuCount?: number;
  /** 跳播定位索引状态：ready=可跳播、building=建立中（入口显式禁用）、missing=未建（兕底回扫）。 */
  seekIndexState?: "ready" | "building" | "missing";
  /** 索引建立进度（0-100，可选展示用）。 */
  seekIndexProgress?: number;
  /** 结束原因（进行中的录制缺省）。 */
  endReason?: RecordingEndReason | null;
  /** 录制中途累计缺失时长（毫秒）：中断恢复后未录到的时间总和。 */
  missingMs?: number | null;
  highlightExportPending?: boolean;
  highlightConfirmationDecision?: boolean | null;
  highlightConfirmationFileName?: string | null;
}

export interface RecordingQuery {
  title?: string;
  page?: number;
  pageSize?: number;
  roomId?: string;
  sessionId?: string;
  state?: RecordingState;
  groupBy?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PagedRecordings {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
}
