import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

const CACHE_TTL_MS = 5_000;
const MAX_DAYS = 365;

/** 统计看板（V5 B4）：服务端聚合 + 短缓存，本地时区切日，可由录制列表复算。 */
export function aggregateStats(services: Services, opts: { from: string; to: string; platform?: string; tagId?: string; roomId?: string }): unknown {
  const key = JSON.stringify(opts);
  const cache = services.statsCache;
  if (cache && cache.key === key && services.clock.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.body;
  }

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.platform) {
    where.push('platform = ?');
    params.push(opts.platform);
  }
  if (opts.roomId) {
    where.push('room_id = ?');
    params.push(opts.roomId);
  }
  if (opts.tagId) {
    const tagIds = opts.tagId.split(',');
    where.push(`room_id IN (SELECT room_id FROM room_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
    params.push(...tagIds);
  }
  where.push('started_at >= ?');
  params.push(opts.from);
  where.push('started_at <= ?');
  params.push(opts.to);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = services.db
    .prepare(
      `SELECT state, platform, started_at, ended_at, file_size_bytes FROM recordings ${whereSql}
       ORDER BY started_at ASC`,
    )
    .all(...params) as Array<{ state: string; platform: string; started_at: string; ended_at: string | null; file_size_bytes: number | null }>;

  const totalCount = rows.length;
  const completed = rows.filter((r) => r.state === 'completed').length;
  const failed = rows.filter((r) => r.state === 'failed').length;
  const totalBytes = rows.reduce((acc, r) => acc + (r.file_size_bytes ?? 0), 0);
  const totalDurationMs = rows.reduce(
    (acc, r) => acc + (r.started_at && r.ended_at ? Math.max(0, new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) : 0),
    0,
  );
  const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : 100;

  const byDayMap = new Map<string, { recordings: number; durationMs: number; bytes: number }>();
  const byPlatformMap = new Map<string, { recordings: number; durationMs: number; bytes: number }>();
  for (const r of rows) {
    const day = r.started_at.slice(0, 10);
    const dayCur = byDayMap.get(day) ?? { recordings: 0, durationMs: 0, bytes: 0 };
    dayCur.recordings += 1;
    dayCur.durationMs += r.started_at && r.ended_at ? Math.max(0, new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) : 0;
    dayCur.bytes += r.file_size_bytes ?? 0;
    byDayMap.set(day, dayCur);

    const platformCur = byPlatformMap.get(r.platform) ?? { recordings: 0, durationMs: 0, bytes: 0 };
    platformCur.recordings += 1;
    platformCur.durationMs += r.started_at && r.ended_at ? Math.max(0, new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) : 0;
    platformCur.bytes += r.file_size_bytes ?? 0;
    byPlatformMap.set(r.platform, platformCur);
  }

  const byDay = [...byDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, recordings: v.recordings, durationMs: v.durationMs, bytes: v.bytes }));
  const byPlatform = [...byPlatformMap.entries()].map(([platform, v]) => ({ platform, recordings: v.recordings, durationMs: v.durationMs, bytes: v.bytes }));

  const body = {
    from: opts.from,
    to: opts.to,
    totals: { recordings: totalCount, completed, failed, durationMs: totalDurationMs, bytes: totalBytes, successRate },
    byDay,
    byPlatform,
    generatedAt: services.clock.iso(),
  };
  services.statsCache = { key, cachedAt: services.clock.now(), body };
  return body;
}

export function registerStatsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/stats/recordings', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const to = qs.to ?? services.clock.iso();
    const from = qs.from ?? new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) > Date.parse(to)) {
      throw new AppError('CONFIG_INVALID', 'from/to 时间范围非法');
    }
    if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 24 * 60 * 60 * 1000) {
      throw new AppError('CONFIG_INVALID', `统计时间跨度最长 ${MAX_DAYS} 天`);
    }
    if (qs.platform !== undefined && qs.platform !== 'bilibili' && qs.platform !== 'douyin') {
      throw new AppError('CONFIG_INVALID', 'platform 仅支持 bilibili/douyin');
    }
    return reply.send(
      aggregateStats(services, {
        from,
        to,
        ...(qs.platform !== undefined ? { platform: qs.platform } : {}),
        ...(qs.tagId !== undefined ? { tagId: qs.tagId } : {}),
        ...(qs.roomId !== undefined ? { roomId: qs.roomId } : {}),
      }),
    );
  });
}