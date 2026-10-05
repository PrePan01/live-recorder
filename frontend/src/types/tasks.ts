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
  updatedAt: string;
}
