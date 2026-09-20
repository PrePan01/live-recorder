import type { Platform } from './room';
import type { ApiErrorEnvelope } from './error';


export type RecordingState = 'pending' | 'recording' | 'reconnecting' | 'awaiting_confirmation' | 'processing' | 'completed' | 'failed';

export type RecordingIntegrity = 'verified' | 'failed' | 'pending';

/**
 * 录制结束原因：natural=直播结束自然收尾、stopped=手动停止、
 * interrupted=中断（网络/写盘）停止、service_restart=服务重启中断。
 */
export type RecordingEndReason = 'natural' | 'stopped' | 'interrupted' | 'service_restart';

export type PipelineStatus = 'not_required' | 'queued' | 'running' | 'ok' | 'partial' | 'failed';

export type UploadSnapshotStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

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

export interface Recording {
  id: string;
  roomId: string;
  roomName: string;
  platform: Platform;
  streamSessionId: string | null;
  streamTitle: string;
  quality: string | null;
  /** 录制发起时的期望画质快照，历史页据此判断画质回退（不依赖当前设置）。 */
  expectedQuality: string | null;
  integrity: RecordingIntegrity | null;
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
  /** 结束原因（进行中的录制缺省）。 */
  endReason?: RecordingEndReason | null;
  /** 录制中途累计缺失时长（毫秒）：中断恢复后未录到的时间总和。 */
  missingMs?: number | null;
  highlightExportPending?: boolean;
  highlightConfirmationDecision?: boolean | null;
  highlightConfirmationFileName?: string | null;
}

export interface RecordingQuery {
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
