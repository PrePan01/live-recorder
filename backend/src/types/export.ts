export type ExportJobStatus = 'queued' | 'running' | 'ok' | 'partial' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  status: ExportJobStatus;
  recordingIds: string[];
  outputPath: string | null;
  manifestPath: string | null;
  sizeBytes: number | null;
  error: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}