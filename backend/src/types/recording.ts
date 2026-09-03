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
  quality?: Quality;
  integrity?: RecordingIntegrity;
  /** V5 后处理管线状态（未参与管线时缺省）。 */
  pipelineStatus?: PipelineStatus;
  /** V5 后处理 sidecar 元数据（真实时长/片段数/清晰度/大小）。 */
  metadata?: RecordingMetadata;
  /** V5 封面帧路径（可选，媒体封面占位 404）。 */
  coverPath?: string;
  /** V5 最近上传任务快照（历史页上传状态列，无任务时缺省）。 */
  upload?: { status: UploadJobStatus; progress: number; remotePath: string | null; error: string | null };
}
