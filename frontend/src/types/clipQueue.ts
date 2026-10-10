export type ClipQueueState =
  | "queued"
  | "running"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ClipQueueItem {
  id: string;
  recordingTitle?: string;
  recordingId: string;
  batchId: string;
  markerId: string | null;
  outputRecordingId: string | null;
  startSecond: number;
  endSecond: number;
  fileName: string;
  encodePolicy: { encodingMode: "auto" | "software" };
  state: ClipQueueState;
  sortOrder: number;
  attempts: number;
  error: string | null;
  actualEncoder: string | null;
  fallbackReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
