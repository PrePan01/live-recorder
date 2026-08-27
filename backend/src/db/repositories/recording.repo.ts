import type { DB } from '../connection.js';
import type { ErrorObject, Platform, Recording, RecordingState } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface RecordingRow {
  id: string;
  room_id: string;
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
  created_at: string;
}

function parseError(raw: string | null): ErrorObject | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ErrorObject;
  } catch {
    return null;
  }
}

/** quality 为内部字段（阶段 C 清晰度追踪），API 模型不输出。 */
export function rowToRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    roomId: row.room_id,
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
}

export interface RecordingListQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  roomId?: string | undefined;
  state?: RecordingState | undefined;
  sessionId?: string | undefined;
  groupBy?: 'session' | undefined;
}

export class RecordingRepository {
  constructor(private db: DB) {}

  create(input: {
    roomId: string;
    platform: Platform;
    streamSessionId: string | null;
    streamTitle: string;
    quality?: string;
  }): Recording {
    const now = nowIso();
    const rec: Recording = {
      id: newId('rec'),
      roomId: input.roomId,
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
        `INSERT INTO recordings (id, room_id, platform, stream_session_id, stream_title, state, started_at, created_at, quality)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(rec.id, rec.roomId, rec.platform, rec.streamSessionId, rec.streamTitle, now, now, input.quality ?? null);
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
    return { items: rows.map(rowToRecording), total, page, pageSize };
  }

  /** 同一场直播去重依据：该 room+session 是否已有非 failed 的录制。 */
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

  update(id: string, patch: Partial<{ state: RecordingState; endedAt: string; filePath: string; fileSizeBytes: number; failureReason: ErrorObject | null; retryCount: number }>): Recording {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
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
    if (sets.length) {
      this.db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.get(id)!;
  }
}
