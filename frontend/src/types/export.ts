export type ExportStatus =
  "queued" | "running" | "ok" | "partial" | "failed" | "cancelled";

export interface ExportJob {
  actualEncoder?: string | null;
  fallbackReason?: string | null;
  id: string;
  status: ExportStatus;
  recordingIds: string[];
  outputPath: string | null;
  manifestPath: string | null;
  sizeBytes: number | null;
  error: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}
