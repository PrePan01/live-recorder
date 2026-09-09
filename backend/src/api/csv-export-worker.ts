import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';

type Filters = { roomId?: string | undefined; state?: string | undefined; sessionId?: string | undefined; dateFrom?: string | undefined; dateTo?: string | undefined };
type Cursor = { startedAt: string; id: string } | undefined;
type Request = { id: number; kind: 'start' | 'next' | 'close'; filters?: Filters; cursor?: Cursor };

const db = new Database((workerData as { path: string }).path, { readonly: true, fileMustExist: true });
let transactionOpen = false;

function page(filters: Filters, cursor: Cursor) {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.roomId) { where.push('room_id = ?'); params.push(filters.roomId); }
  if (filters.state) { where.push('state = ?'); params.push(filters.state); }
  if (filters.sessionId) { where.push('stream_session_id = ?'); params.push(filters.sessionId); }
  if (filters.dateFrom) { where.push('started_at >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('started_at <= ?'); params.push(filters.dateTo); }
  if (cursor) { where.push('(started_at < ? OR (started_at = ? AND id < ?))'); params.push(cursor.startedAt, cursor.startedAt, cursor.id); }
  const sql = `SELECT id, room_id, platform, stream_title, state, started_at, ended_at, file_size_bytes, quality, integrity FROM recordings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT 500`;
  return db.prepare(sql).all(...params) as Array<{ id: string; room_id: string; platform: string; stream_title: string; state: string; started_at: string; ended_at: string | null; file_size_bytes: number | null; quality: string | null; integrity: string | null }>;
}

parentPort?.on('message', (request: Request) => {
  try {
    if (request.kind === 'start') {
      db.exec('BEGIN');
      transactionOpen = true;
      parentPort?.postMessage({ id: request.id, result: true });
    } else if (request.kind === 'next') {
      parentPort?.postMessage({ id: request.id, result: page(request.filters ?? {}, request.cursor) });
    } else {
      if (transactionOpen) db.exec('COMMIT');
      transactionOpen = false;
      parentPort?.postMessage({ id: request.id, result: true });
    }
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
