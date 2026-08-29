import type { DB } from '../connection.js';
import type { ExportJob, ExportJobStatus } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface ExportJobRow {
  id: string;
  status: string;
  recording_ids: string;
  output_path: string | null;
  manifest_path: string | null;
  size_bytes: number | null;
  error: string | null;
  progress: number;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: ExportJobRow): ExportJob {
  let ids: string[] = [];
  try {
    ids = JSON.parse(row.recording_ids) as string[];
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    status: row.status as ExportJobStatus,
    recordingIds: ids,
    outputPath: row.output_path,
    manifestPath: row.manifest_path,
    sizeBytes: row.size_bytes,
    error: row.error,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExportRepository {
  constructor(private db: DB) {}

  create(input: { recordingIds: string[] }): ExportJob {
    const id = newId('exp');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO export_jobs (id, status, recording_ids, output_path, manifest_path, size_bytes, error, progress, created_at, updated_at)
         VALUES (?, 'queued', ?, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(id, JSON.stringify(input.recordingIds), now, now);
    return this.get(id)!;
  }

  get(id: string): ExportJob | null {
    const row = this.db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(id) as ExportJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  list(opts: { limit?: number } = {}): ExportJob[] {
    const rows = this.db.prepare('SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 100) as ExportJobRow[];
    return rows.map(rowToJob);
  }

  update(id: string, patch: { status?: ExportJobStatus; outputPath?: string | null; manifestPath?: string | null; sizeBytes?: number | null; error?: string | null; progress?: number }): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.outputPath !== undefined) {
      sets.push('output_path = ?');
      params.push(patch.outputPath);
    }
    if (patch.manifestPath !== undefined) {
      sets.push('manifest_path = ?');
      params.push(patch.manifestPath);
    }
    if (patch.sizeBytes !== undefined) {
      sets.push('size_bytes = ?');
      params.push(patch.sizeBytes);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      params.push(patch.progress);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      this.db.prepare(`UPDATE export_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
  }
}