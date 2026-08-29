import type { DB } from '../connection.js';
import type { UploadJob, UploadJobStatus } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface UploadJobRow {
  id: string;
  recording_id: string;
  status: string;
  progress: number;
  remote_path: string | null;
  error: string | null;
  retry_count: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: UploadJobRow): UploadJob {
  return {
    id: row.id,
    recordingId: row.recording_id,
    status: row.status as UploadJobStatus,
    progress: row.progress,
    remotePath: row.remote_path,
    error: row.error,
    retryCount: row.retry_count,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UploadRepository {
  constructor(private db: DB) {}

  create(input: { recordingId: string; idempotencyKey: string }): UploadJob {
    const id = newId('upl');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO upload_jobs (id, recording_id, status, progress, remote_path, error, retry_count, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, NULL, NULL, 0, ?, ?, ?)`,
      )
      .run(id, input.recordingId, input.idempotencyKey, now, now);
    return this.get(id)!;
  }

  get(id: string): UploadJob | null {
    const row = this.db.prepare('SELECT * FROM upload_jobs WHERE id = ?').get(id) as UploadJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  jobForRecording(recordingId: string): UploadJob | null {
    const row = this.db
      .prepare('SELECT * FROM upload_jobs WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(recordingId) as UploadJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  list(opts: { limit?: number } = {}): UploadJob[] {
    const rows = this.db.prepare('SELECT * FROM upload_jobs ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 100) as UploadJobRow[];
    return rows.map(rowToJob);
  }

  update(id: string, patch: { status?: UploadJobStatus; progress?: number; remotePath?: string | null; error?: string | null; retryCount?: number }): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      params.push(patch.progress);
    }
    if (patch.remotePath !== undefined) {
      sets.push('remote_path = ?');
      params.push(patch.remotePath);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.retryCount !== undefined) {
      sets.push('retry_count = ?');
      params.push(patch.retryCount);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      this.db.prepare(`UPDATE upload_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
  }
}