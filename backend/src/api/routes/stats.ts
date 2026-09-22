import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

const CACHE_TTL_MS = 5_000;
const MAX_DAYS = 365;

/**
 * 单行时长（ms）：julianday 差值 ROUND 到毫秒。
 * 两端时间戳均来自 ISO（毫秒精度），真实差值恒为整数毫秒；
 * julianday 双精度误差 ≪0.5ms，ROUND 后与 JS `new Date(a)-new Date(b)` 精确一致，
 * 且逐行求和无截断偏差（不用 CAST 直接截断）。
 * ended_at 为 NULL（进行中录制）计 0。
 */
const DUR_MS_SQL = `CASE WHEN ended_at IS NOT NULL
  THEN MAX(0, CAST(ROUND((julianday(ended_at) - julianday(started_at)) * 86400000.0) AS INTEGER))
  ELSE 0 END`;

/**
 * 统计看板（V5 B4 → 看板重做 task #52）：单次 SQL GROUP BY 立方体扫描 + JS 组级折叠 + 短缓存。
 *
 * 架构：一次扫描 GROUP BY (本地日, 平台, 房间) 同时产出四组聚合所需全部字段，
 * JS 仅在组级（≤日×平台×房间基数）折叠出 totals/byDay/byPlatform/byRoom——
 * 满足 QA F2「无全量行内存放大」（SQL 聚合、组级元数据，非行级）；
 * 相比四条独立聚合查询少扫3次、julianday/localtime 只算一遍（10万行实测约省 40%）。
 *
 * Q6=A（PrePan 拍板）：本地时区切日（datetime(started_at,'localtime')），
 * 与 FE 展示/录制列表「本地日」口径一致；历史 byDay 柱位移 ≤1 天属预期修正（QA 矩阵 C4）。
 * 响应只加不改：totals/byDay/byPlatform 结构与旧版一致，新增 byRoom（评审稿 v2）。
 */
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

  const db = services.db;

  // 单立方体扫描：GROUP BY (本地日, 平台, 房间)——四组聚合的全部度量一次出。
  // - 图表计数 = 全 state（QA B3）：completed/failed 单列 SUM 供 totals 折叠出 successRate；
  // - room_name 取 MAX(started_at) 所在行快照（恰一个 MAX 聚合时裸列取该行语义），
  //   折叠时跨组取 latestStarted 最大者 = 房间最新快照，确定性（QA 改名房间断言）；
  // - totals/byDay/byPlatform/byRoom 均由同一组级结果折叠，口径天然一致。
  const cubeRows = db
    .prepare(
      `SELECT substr(datetime(started_at, 'localtime'), 1, 10) AS date,
        platform,
        room_id AS roomId,
        room_name AS roomName,
        MAX(started_at) AS latestStarted,
        COUNT(*) AS recordings,
        COALESCE(SUM(state = 'completed'), 0) AS completed,
        COALESCE(SUM(state = 'failed'), 0) AS failed,
        COALESCE(SUM(COALESCE(file_size_bytes, 0)), 0) AS bytes,
        COALESCE(SUM(${DUR_MS_SQL}), 0) AS durationMs
       FROM recordings ${whereSql}
       GROUP BY date, platform, room_id`,
    )
    .all(...params) as Array<{
      date: string;
      platform: string;
      roomId: string;
      roomName: string;
      latestStarted: string;
      recordings: number;
      completed: number;
      failed: number;
      bytes: number;
      durationMs: number;
    }>;

  // ---- 组级折叠（内存 ∝ 组数，非行数）----
  let totalRecordings = 0;
  let totalCompleted = 0;
  let totalFailed = 0;
  let totalBytes = 0;
  let totalDurationMs = 0;
  const byDayMap = new Map<string, { recordings: number; durationMs: number; bytes: number }>();
  const byPlatformMap = new Map<string, { recordings: number; durationMs: number; bytes: number }>();
  const byRoomMap = new Map<string, { roomName: string; latestStarted: string; recordings: number; durationMs: number; bytes: number }>();
  for (const c of cubeRows) {
    totalRecordings += c.recordings;
    totalCompleted += c.completed;
    totalFailed += c.failed;
    totalBytes += c.bytes;
    totalDurationMs += c.durationMs;

    const day = byDayMap.get(c.date) ?? { recordings: 0, durationMs: 0, bytes: 0 };
    day.recordings += c.recordings;
    day.durationMs += c.durationMs;
    day.bytes += c.bytes;
    byDayMap.set(c.date, day);

    const plat = byPlatformMap.get(c.platform) ?? { recordings: 0, durationMs: 0, bytes: 0 };
    plat.recordings += c.recordings;
    plat.durationMs += c.durationMs;
    plat.bytes += c.bytes;
    byPlatformMap.set(c.platform, plat);

    const room = byRoomMap.get(c.roomId);
    if (!room) {
      byRoomMap.set(c.roomId, { roomName: c.roomName, latestStarted: c.latestStarted, recordings: c.recordings, durationMs: c.durationMs, bytes: c.bytes });
    } else {
      room.recordings += c.recordings;
      room.durationMs += c.durationMs;
      room.bytes += c.bytes;
      if (c.latestStarted > room.latestStarted) room.roomName = c.roomName; // 全局最新快照
    }
  }

  const successRate = totalCompleted + totalFailed > 0 ? Math.round((totalCompleted / (totalCompleted + totalFailed)) * 100) : 100;

  const body = {
    from: opts.from,
    to: opts.to,
    totals: {
      recordings: totalRecordings,
      completed: totalCompleted,
      failed: totalFailed,
      durationMs: totalDurationMs,
      bytes: totalBytes,
      successRate,
    },
    byDay: [...byDayMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, recordings: v.recordings, durationMs: v.durationMs, bytes: v.bytes })),
    // 平台名排序（bilibili<douyin，与旧版首现顺序在常规数据下一致；结构只加不改）。
    byPlatform: [...byPlatformMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([platform, v]) => ({ platform, recordings: v.recordings, durationMs: v.durationMs, bytes: v.bytes })),
    // 返全量分组（Q3 可展开全部零后端成本），TOP10+其他由前端切。
    byRoom: [...byRoomMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([roomId, v]) => ({ roomId, roomName: v.roomName, recordings: v.recordings, durationMs: v.durationMs, bytes: v.bytes })),
    generatedAt: services.clock.iso(),
  };
  services.statsCache = { key, cachedAt: services.clock.now(), body };
  return body;
}

export function registerStatsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/stats/recordings', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const toRaw = qs.to ?? services.clock.iso();
    const fromRaw = qs.from ?? new Date(Date.parse(toRaw) - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(fromRaw)) || !Number.isFinite(Date.parse(toRaw)) || Date.parse(fromRaw) > Date.parse(toRaw)) {
      throw new AppError('CONFIG_INVALID', 'from/to 时间范围非法');
    }
    if (Date.parse(toRaw) - Date.parse(fromRaw) > MAX_DAYS * 24 * 60 * 60 * 1000) {
      throw new AppError('CONFIG_INVALID', `统计时间跨度最长 ${MAX_DAYS} 天`);
    }
    if (qs.platform !== undefined && qs.platform !== 'bilibili' && qs.platform !== 'douyin') {
      throw new AppError('CONFIG_INVALID', 'platform 仅支持 bilibili/douyin');
    }
    // 归一化为 UTC ISO（毫秒）再进 SQL：存储恒为 toISOString 的 Z 串，
    // 字符串序比较仅在同为 Z 形态时等于时间序——防调用方传 +08:00 等偏移导致小时边界错切。
    const from = new Date(Date.parse(fromRaw)).toISOString();
    const to = new Date(Date.parse(toRaw)).toISOString();
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
