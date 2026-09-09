import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';

type SearchType = 'room' | 'recording' | 'alert';
type Item = { type: SearchType; id: string; title: string; subtitle: string; occurredAt: string | null; extra: Record<string, unknown> };
type Request = { id: number; opts: { q: string; type?: SearchType; tagId?: string; from?: string; to?: string; page?: number; pageSize?: number } };

const db = new Database((workerData as { path: string }).path, { readonly: true, fileMustExist: true });

function like(q: string): string { return `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`; }

function run(opts: Request['opts']) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 20));
  const limit = Math.min(5_000, page * pageSize);
  const pattern = like(opts.q);
  const items: Item[] = [];
  let total = 0;
  if (!opts.type || opts.type === 'room') {
    const where: string[] = [];
    const params: string[] = [];
    const tags = opts.tagId?.split(',').filter(Boolean) ?? [];
    if (tags.length) { where.push(`r.id IN (SELECT room_id FROM room_tags WHERE tag_id IN (${tags.map(() => '?').join(',')}))`); params.push(...tags); }
    if (opts.from) { where.push('r.created_at >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('r.created_at <= ?'); params.push(opts.to); }
    const hit = `(r.display_name LIKE ? ESCAPE '\\' OR r.url LIKE ? ESCAPE '\\' OR r.id IN (SELECT room_id FROM room_tags rt JOIN tags t ON t.id = rt.tag_id WHERE t.name LIKE ? ESCAPE '\\'))`;
    const sql = `WHERE ${where.length ? `${where.join(' AND ')} AND ` : ''}${hit}`;
    const values = [...params, pattern, pattern, pattern];
    const rows = db.prepare(`SELECT r.id,r.display_name,r.url,r.last_checked_at,r.updated_at FROM rooms r ${sql} ORDER BY r.created_at DESC LIMIT ?`).all(...values, limit) as Array<{ id: string; display_name: string; url: string; last_checked_at: string | null; updated_at: string }>;
    total += (db.prepare(`SELECT COUNT(*) AS c FROM rooms r ${sql}`).get(...values) as { c: number }).c;
    items.push(...rows.map((r) => ({ type: 'room' as const, id: r.id, title: r.display_name || r.id, subtitle: r.url, occurredAt: r.last_checked_at ?? r.updated_at, extra: {} })));
  }
  if (!opts.type || opts.type === 'recording') {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.from) { where.push('started_at >= ?'); params.push(opts.from); }
    if (opts.to) { where.push('started_at <= ?'); params.push(opts.to); }
    const hit = `(stream_title LIKE ? ESCAPE '\\' OR room_name LIKE ? ESCAPE '\\' OR id = ?)`;
    const sql = `WHERE ${where.length ? `${where.join(' AND ')} AND ` : ''}${hit}`;
    const values = [...params, pattern, pattern, opts.q];
    const rows = db.prepare(`SELECT id,room_name,stream_title,started_at FROM recordings ${sql} ORDER BY started_at DESC LIMIT ?`).all(...values, limit) as Array<{ id: string; room_name: string; stream_title: string; started_at: string }>;
    total += (db.prepare(`SELECT COUNT(*) AS c FROM recordings ${sql}`).get(...values) as { c: number }).c;
    items.push(...rows.map((r) => ({ type: 'recording' as const, id: r.id, title: r.stream_title || r.room_name || r.id, subtitle: `${r.room_name || ''} · ${r.started_at}`, occurredAt: r.started_at, extra: {} })));
  }
  if (!opts.type || opts.type === 'alert') {
    const rows = db.prepare(`SELECT id,message,source,occurred_at FROM alerts WHERE message LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' ORDER BY occurred_at DESC LIMIT ?`).all(pattern, pattern, limit) as Array<{ id: string; message: string; source: string; occurred_at: string }>;
    total += (db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE message LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'`).get(pattern, pattern) as { c: number }).c;
    items.push(...rows.map((r) => ({ type: 'alert' as const, id: r.id, title: r.message, subtitle: r.source, occurredAt: r.occurred_at, extra: {} })));
  }
  items.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '') || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, timeout: false };
}

parentPort?.on('message', (request: Request) => {
  try { parentPort?.postMessage({ id: request.id, result: run(request.opts) }); }
  catch (error) { parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
});
