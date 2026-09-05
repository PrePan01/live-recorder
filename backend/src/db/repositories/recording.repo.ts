import type { DB } from '../connection.js';
import type { ErrorObject, Platform, Quality, Recording, RecordingIntegrity, RecordingMetadata, RecordingState, PipelineStatus, UploadJobStatus } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface RecordingRow {
  id: string;
  room_id: string;
  room_name: string;
  platform: string;
  stream_session_id: string | null;
  stream_title: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  file_path: string | null;
  file_size_bytes: number | null;
  failure_reason: string | null;
  retry_count: number | null;
  quality: string | null;
  expected_quality: string | null;
  integrity: string | null;
  pipeline_status: string | null;
  metadata: string | null;
  cover_path: string | null;
  created_at: string;
  upload?: { status: string; progress: number; remotePath: string | null; error: string | null };
}

function parseError(raw: string | null): ErrorObject | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ErrorObject;
  } catch {
    return null;
  }
}

function parseMetadata(raw: string | null): RecordingMetadata | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RecordingMetadata;
  } catch {
    return undefined;
  }
}

/** quality 为内部字段（阶段 C 清晰度追踪），v2.0 起输出到 API 供历史页展示。 */
export function rowToRecording(row: RecordingRow): Recording {
  const rec: Recording = {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name ?? '',
    platform: row.platform as Platform,
    streamSessionId: row.stream_session_id,
    streamTitle: row.stream_title,
    state: row.state as RecordingState,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    filePath: row.file_path,
    fileSizeBytes: row.file_size_bytes ?? 0,
    failureReason: parseError(row.failure_reason),
    retryCount: row.retry_count ?? 0,
    createdAt: row.created_at,
  };
  if (row.quality) rec.quality = row.quality as Quality;
  if (row.expected_quality) rec.expectedQuality = row.expected_quality as Quality;
  if (row.integrity) rec.integrity = row.integrity as RecordingIntegrity;
  if (row.pipeline_status) rec.pipelineStatus = row.pipeline_status as PipelineStatus;
  const metadata = parseMetadata(row.metadata);
  if (metadata) rec.metadata = metadata;
  if (row.cover_path) rec.coverPath = row.cover_path;
  if (row.upload) rec.upload = { ...row.upload, status: row.upload.status as UploadJobStatus };
  return rec;
}

export interface RecordingListQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  roomId?: string | undefined;
  state?: RecordingState | undefined;
  sessionId?: string | undefined;
  groupBy?: 'session' | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export class RecordingRepository {
  constructor(private db: DB) {}

  create(input: {
    roomId: string;
    roomName: string;
    platform: Platform;
    streamSessionId: string | null;
    streamTitle: string;
    quality?: string;
    expectedQuality?: string;
  }): Recording {
    const now = nowIso();
    const rec: Recording = {
      id: newId('rec'),
      roomId: input.roomId,
      roomName: input.roomName,
      platform: input.platform,
      streamSessionId: input.streamSessionId,
      streamTitle: input.streamTitle,
      state: 'pending',
      startedAt: now,
      endedAt: null,
      filePath: null,
      fileSizeBytes: 0,
      failureReason: null,
      retryCount: 0,
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO recordings (id, room_id, room_name, platform, stream_session_id, stream_title, state, started_at, created_at, quality, expected_quality)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.roomId, rec.roomName, rec.platform, rec.streamSessionId, rec.streamTitle, now, now, input.quality ?? null, input.expectedQuality ?? null);
    return rec;
  }

  get(id: string): Recording | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;
    return row ? rowToRecording(row) : null;
  }

  list(query: RecordingListQuery = {}): { items: Recording[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.roomId) {
      where.push('room_id = ?');
      params.push(query.roomId);
    }
    if (query.state) {
      where.push('state = ?');
      params.push(query.state);
    }
    if (query.sessionId) {
      where.push('stream_session_id = ?');
      params.push(query.sessionId);
    }
    if (query.dateFrom) {
      where.push('started_at >= ?');
      params.push(query.dateFrom);
    }
    if (query.dateTo) {
      where.push('started_at <= ?');
      params.push(query.dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM recordings ${whereSql}`).get(...params) as { c: number }).c;
    const sql = `SELECT * FROM recordings ${whereSql} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, pageSize, (page - 1) * pageSize) as RecordingRow[];
    if (query.groupBy === 'session') {
      // 同场直播多段（重连续录）合并为一组，取每组最新状态代表
      const bySession = new Map<string, RecordingRow>();
      for (const row of rows) {
        const key = `${row.room_id}|${row.stream_session_id ?? row.id}`;
        const prev = bySession.get(key);
        if (!prev || row.started_at > prev.started_at) bySession.set(key, row);
      }
      rows.length = 0;
      rows.push(...bySession.values());
    }
    this.attachUploadSnapshots(rows);
    return { items: rows.map(rowToRecording), total, page, pageSize };
  }

  /** 批量附最近上传任务快照（#190）：单次窗口函数查询取每录制最新任务，避免 N+1。 */
  private attachUploadSnapshots(rows: RecordingRow[]): void {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const latest = this.db
      .prepare(
        `SELECT recording_id, status, progress, remote_path, error FROM (
           SELECT recording_id, status, progress, remote_path, error,
                  ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY updated_at DESC, created_at DESC, id DESC) AS rn
           FROM upload_jobs WHERE recording_id IN (${marks})
         ) WHERE rn = 1`,
      )
      .all(...ids) as Array<{ recording_id: string; status: string; progress: number; remote_path: string | null; error: string | null }>;
    const byRec = new Map(latest.map((u) => [u.recording_id, u]));
    for (const row of rows) {
      const u = byRec.get(row.id);
      if (u) row.upload = { status: u.status, progress: u.progress, remotePath: u.remote_path, error: u.error };
    }
  }

  /** 同一场直播去重依据：该 room+session 是否已有非 failed 的录制。手动重录由 maybeStartRecording 的 manual 标志处理，此处不排除。 */
  hasSession(roomId: string, streamSessionId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM recordings WHERE room_id = ? AND stream_session_id = ? AND state != 'failed' LIMIT 1`)
      .get(roomId, streamSessionId) as { x: number } | undefined;
    return row !== undefined;
  }

  activeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM recordings WHERE state IN ('pending', 'recording', 'reconnecting')`)
      .get() as { c: number };
    return row.c;
  }

  update(id: string, patch: Partial<{ state: RecordingState; endedAt: string; startedAt: string; filePath: string; fileSizeBytes: number; failureReason: ErrorObject | null; retryCount: number; streamTitle: string; integrity: string; pipelineStatus: PipelineStatus; metadata: RecordingMetadata | null; coverPath: string | null }>): Recording {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.integrity !== undefined) {
      sets.push('integrity = ?');
      params.push(patch.integrity);
    }
    if (patch.pipelineStatus !== undefined) {
      sets.push('pipeline_status = ?');
      params.push(patch.pipelineStatus);
    }
    if (patch.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(patch.metadata ? JSON.stringify(patch.metadata) : null);
    }
    if (patch.coverPath !== undefined) {
      sets.push('cover_path = ?');
      params.push(patch.coverPath);
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?');
      params.push(patch.endedAt);
    }
    if (patch.filePath !== undefined) {
      sets.push('file_path = ?');
      params.push(patch.filePath);
    }
    if (patch.fileSizeBytes !== undefined) {
      sets.push('file_size_bytes = ?');
      params.push(patch.fileSizeBytes);
    }
    if (patch.failureReason !== undefined) {
      sets.push('failure_reason = ?');
      params.push(patch.failureReason ? JSON.stringify(patch.failureReason) : null);
    }
    if (patch.retryCount !== undefined) {
      sets.push('retry_count = ?');
      params.push(patch.retryCount);
    }
    if (patch.streamTitle !== undefined) {
      sets.push('stream_title = ?');
      params.push(patch.streamTitle);
    }
    if (sets.length) {
      this.db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  }
}
