/** 流健康状态（会议版质量灯判据）：语义态由后端出、颜色由显示面映射。 */
export type StreamHealthState = "good" | "degraded" | "empty" | "unknown";

export interface StreamHealth {
  recordingId: string;
  state: StreamHealthState;
  /** 人话原因（degraded/empty 必填）。 */
  reason?: string | null;
  /** 最近数据时间。 */
  lastDataAt?: number | null;
  /** 实际画质是否发生回退。 */
  qualityFallback?: boolean;
  issue?: "no_data" | "write_error" | "low_bitrate" | "media_stalled" | null;
  sampledAt?: number;
  silenceMs?: number;
  recovering?: boolean;
  missingMs?: number;
  active?: boolean;
}
