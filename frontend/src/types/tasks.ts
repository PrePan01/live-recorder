export type TaskKind = "clip" | "pipeline" | "upload" | "export";

export interface TaskItem {
  id: string;
  kind: TaskKind;
  recordingId?: string;
  title: string;
  state: string;
  progressPercent?: number;
  step?: string | null;
  etaSeconds?: number | null;
  error?: string | null;
  /** 实际编码方式（枚举值）；copy=无损复制。 */
  actualEncoder?: string | null;
  /** 回退原因人话（仅回退后出现）；未回退=null。 */
  fallbackReason?: string | null;
  updatedAt: string;
}
