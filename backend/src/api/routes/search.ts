import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

export type SearchType = 'room' | 'recording' | 'alert';

const SEARCH_TIMEOUT_MS = 3_000;
const MIN_QUERY = 1;
const MAX_QUERY = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface SearchResultItem {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  /** 命中时间（房间=lastCheckedAt/updatedAt、录制=startedAt、告警=occurredAt）。 */
  occurredAt: string | null;
  extra: Record<string, unknown>;
}

interface SearchOutcome {
  items: SearchResultItem[];
  total: number;
  page: number;
  pageSize: number;
  timeout: boolean;
}

interface TimeFilter {
  from: string | null;
  to: string | null;
}

/** 全局搜索（V5 B3）：参数化 LIKE、分页上限、查询超时兜底，禁全表扫描危险查询。 */
export function searchAll(services: Services, opts: { q: string; type?: SearchType; tagId?: string; from?: string; to?: string; page?: number; pageSize?: number }): SearchOutcome {
  const q = opts.q;
  const type = opts.type;
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const started = services.clock.now();

  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const items: SearchResultItem[] = [];
  const totals: Array<[SearchType, number]> = [];
  const time: TimeFilter = { from: opts.from ?? null, to: opts.to ?? null };

  if (!type || type === 'room') {
    const { items: roomItems, total } = searchRooms(services, q, like, time, opts.tagId, page, pageSize);
    items.push(...roomItems);
    totals.push(['room', total]);
  }

  if (services.clock.now() - started > SEARCH_TIMEOUT_MS) {
    return { items, total: sumTotals(totals), page, pageSize, timeout: true };
  }

  if (!type || type === 'recording') {
    const { items: recItems, total } = searchRecordings(services, q, like, time, page, pageSize);
    items.push(...recItems);
    totals.push(['recording', total]);
  }

  if (services.clock.now() - started > SEARCH_TIMEOUT_MS) {
    return { items, total: sumTotals(totals), page, pageSize, timeout: true };
  }

  if (!type || type === 'alert') {
    const { items: alertItems, total } = searchAlerts(services, like, page, pageSize);
    items.push(...alertItems);
    totals.push(['alert', total]);
  }

  return { items, total: sumTotals(totals), page, pageSize, timeout: false };
}

interface RoomSearchRow {
  id: string;
  display_name: string;
  url: string;
  last_checked_at: string | null;
  updated_at: string;
}

function searchRooms(services: Services, q: string, like: string, time: TimeFilter, tagId: string | undefined, page: number, pageSize: number): { items: SearchResultItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const tagIds = tagId ? tagId.split(',') : [];
  if (tagIds.length > 0) {
    where.push(`r.id IN (SELECT room_id FROM room_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
    params.push(...tagIds);
  }
  if (time.from) {
    where.push('r.created_at >= ?');
    params.push(time.from);
  }
  if (time.to) {
    where.push('r.created_at <= ?');
    params.push(time.to);
  }
  const hit = `(r.display_name LIKE ? ESCAPE '\\' OR r.url LIKE ? ESCAPE '\\' OR r.id IN (SELECT room_id FROM room_tags rt JOIN tags t ON t.id = rt.tag_id WHERE t.name LIKE ? ESCAPE '\\'))`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')} AND ${hit}` : `WHERE ${hit}`;
  const baseParams = [...params, like, like, like];
  const rows = services.db
    .prepare(
      `SELECT r.id, r.display_name, r.url, r.last_checked_at, r.updated_at FROM rooms r ${whereSql}
       ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...baseParams, pageSize, (page - 1) * pageSize) as RoomSearchRow[];
  const total = (services.db.prepare(`SELECT COUNT(*) AS c FROM rooms r ${whereSql}`).get(...baseParams) as { c: number }).c;
  const items = rows.map((row) => ({
    type: 'room' as const,
    id: row.id,
    title: row.display_name || row.id,
    subtitle: row.url,
    occurredAt: row.last_checked_at ?? row.updated_at,
    extra: {},
  }));
  void q;
  return { items, total };
}

interface RecordingSearchRow {
  id: string;
  room_name: string;
  stream_title: string;
  started_at: string;
}

function searchRecordings(services: Services, q: string, like: string, time: TimeFilter, page: number, pageSize: number): { items: SearchResultItem[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (time.from) {
    where.push('started_at >= ?');
    params.push(time.from);
  }
  if (time.to) {
    where.push('started_at <= ?');
    params.push(time.to);
  }
  const hit = `(stream_title LIKE ? ESCAPE '\\' OR room_name LIKE ? ESCAPE '\\' OR id = ?)`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')} AND ${hit}` : `WHERE ${hit}`;
  const baseParams = [...params, like, like, q];
  const rows = services.db
    .prepare(
      `SELECT id, room_name, stream_title, started_at FROM recordings ${whereSql}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...baseParams, pageSize, (page - 1) * pageSize) as RecordingSearchRow[];
  const total = (services.db.prepare(`SELECT COUNT(*) AS c FROM recordings ${whereSql}`).get(...baseParams) as { c: number }).c;
  const items = rows.map((row) => ({
    type: 'recording' as const,
    id: row.id,
    title: row.stream_title || row.room_name || row.id,
    subtitle: `${row.room_name || ''} · ${row.started_at}`,
    occurredAt: row.started_at,
    extra: {},
  }));
  return { items, total };
}

interface AlertSearchRow {
  id: string;
  message: string;
  source: string;
  occurred_at: string;
}

function searchAlerts(services: Services, like: string, page: number, pageSize: number): { items: SearchResultItem[]; total: number } {
  const rows = services.db
    .prepare(
      `SELECT id, message, source, occurred_at FROM alerts
       WHERE message LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'
       ORDER BY occurred_at DESC LIMIT ? OFFSET ?`,
    )
    .all(like, like, pageSize, (page - 1) * pageSize) as AlertSearchRow[];
  const total = (services.db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE message LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'`).get(like, like) as { c: number }).c;
  const items = rows.map((row) => ({
    type: 'alert' as const,
    id: row.id,
    title: row.message,
    subtitle: row.source,
    occurredAt: row.occurred_at,
    extra: {},
  }));
  return { items, total };
}

function sumTotals(totals: Array<[SearchType, number]>): number {
  let total = 0;
  for (const [, v] of totals) total += v;
  return total;
}

export function registerSearchRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/search', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const q = typeof qs.q === 'string' ? qs.q.trim() : '';
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
      throw new AppError('SEARCH_QUERY_INVALID', `搜索词长度需在 ${MIN_QUERY}-${MAX_QUERY} 之间`);
    }
    const type = qs.type as SearchType | undefined;
    if (type !== undefined && !['room', 'recording', 'alert'].includes(type)) {
      throw new AppError('SEARCH_QUERY_INVALID', 'type 仅支持 room/recording/alert');
    }
    const page = Number(qs.page ?? '1');
    const pageSize = Number(qs.pageSize ?? '20');
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1) {
      throw new AppError('SEARCH_QUERY_INVALID', '分页参数非法');
    }
    try {
      const result = searchAll(services, {
        q,
        ...(type !== undefined ? { type } : {}),
        ...(qs.tagId !== undefined ? { tagId: qs.tagId } : {}),
        ...(qs.from !== undefined ? { from: qs.from } : {}),
        ...(qs.to !== undefined ? { to: qs.to } : {}),
        page,
        pageSize,
      });
      return reply.send({
        query: q,
        type: type ?? 'all',
        tagId: qs.tagId ?? null,
        from: qs.from ?? null,
        to: qs.to ?? null,
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        timeout: result.timeout,
        items: result.items,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('SEARCH_TIMEOUT', '搜索超时，请缩小范围后重试', { retryable: true });
    }
  });
}