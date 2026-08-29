import type { DB } from '../connection.js';
import type { PipelineArtifact, PipelineArtifactStatus, PipelineRun, PipelineRunStatus, PipelineStep } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface PipelineRunRow {
  id: string;
  recording_id: string;
  status: string;
  config_snapshot: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface PipelineArtifactRow {
  id: string;
  run_id: string;
  step: string;
  status: string;
  path: string | null;
  size_bytes: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

function parseSnapshot(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class PipelineRepository {
  constructor(private db: DB) {}

  createRun(input: { recordingId: string; configSnapshot: Record<string, unknown> }): PipelineRun {
    const id = newId('prun');
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, recording_id, status, config_snapshot, started_at, ended_at, created_at)
         VALUES (?, ?, 'queued', ?, NULL, NULL, ?)`,
      )
      .run(id, input.recordingId, JSON.stringify(input.configSnapshot), createdAt);
    return this.getRun(id)!;
  }

  getRun(id: string): PipelineRun | null {
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as PipelineRunRow | undefined;
    if (!row) return null;
    const artifacts = (this.db.prepare('SELECT * FROM pipeline_artifacts WHERE run_id = ? ORDER BY rowid ASC').all(id) as PipelineArtifactRow[]).map(rowToArtifact);
    return {
      id: row.id,
      recordingId: row.recording_id,
      status: row.status as PipelineRunStatus,
      configSnapshot: parseSnapshot(row.config_snapshot),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      artifacts,
    };
  }

  runForRecording(recordingId: string): PipelineRun | null {
    const row = this.db
      .prepare('SELECT * FROM pipeline_runs WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(recordingId) as PipelineRunRow | undefined;
    if (!row) return null;
    return this.getRun(row.id);
  }

  setRunStatus(id: string, status: PipelineRunStatus, endedAt: string | null = null): void {
    this.db
      .prepare(`UPDATE pipeline_runs SET status = ?, started_at = COALESCE(started_at, ?), ended_at = COALESCE(?, ended_at) WHERE id = ?`)
      .run(status, nowIso(), endedAt, id);
  }

  createArtifact(input: { runId: string; step: PipelineStep }): PipelineArtifact {
    const id = newId('part');
    this.db
      .prepare(`INSERT INTO pipeline_artifacts (id, run_id, step, status, path, size_bytes, error, started_at, ended_at) VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL)`)
      .run(id, input.runId, input.step);
    return this.artifact(id)!;
  }

  artifact(id: string): PipelineArtifact | null {
    const row = this.db.prepare('SELECT * FROM pipeline_artifacts WHERE id = ?').get(id) as PipelineArtifactRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  setArtifact(id: string, patch: { status?: PipelineArtifactStatus; path?: string | null; sizeBytes?: number | null; error?: string | null; startedAt?: string | null; endedAt?: string | null }): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.path !== undefined) {
      sets.push('path = ?');
      params.push(patch.path);
    }
    if (patch.sizeBytes !== undefined) {
      sets.push('size_bytes = ?');
      params.push(patch.sizeBytes);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?');
      params.push(patch.endedAt);
    }
    if (sets.length) {
      this.db.prepare(`UPDATE pipeline_artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
  }
}

function rowToArtifact(row: PipelineArtifactRow): PipelineArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    step: row.step as PipelineStep,
    status: row.status as PipelineArtifactStatus,
    path: row.path,
    sizeBytes: row.size_bytes,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}