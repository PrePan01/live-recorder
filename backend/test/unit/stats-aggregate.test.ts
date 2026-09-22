import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { aggregateStats } from '../../src/api/routes/stats.js';

/**
 * 统计看板 BE（task #52）：SQL GROUP BY 下沉 + Q6=A 本地时区切日 + byRoom 契约。
 * 运行时区由 vitest config 固定为 Asia/Shanghai（Q6 新基线的根）。
 */

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 期望本地日：与 SQLite datetime('localtime') 同口径，取 JS Date 本地字段（进程 TZ = vitest env TZ）。 */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type SeedRow = {
  startedAt: string;
  endedAt?: string | null;
  bytes?: number | null;
  platform?: string;
  roomId?: string;
  roomName?: string;
  state?: string;
};

function seed(services: Services, rows: SeedRow[]): void {
  // recordings.room_id FK（PRAGMA foreign_keys=ON）：先建房间（room_name 快照仍存在 recordings 上）。
  const room = services.db.prepare('INSERT OR IGNORE INTO rooms (id, platform, url) VALUES (?, ?, ?)');
  for (const id of new Set(rows.map((r) => r.roomId ?? 'room-a'))) {
    room.run(id, 'bilibili', `https://example.invalid/room/${id}`);
  }
  const insert = services.db.prepare(
    `INSERT INTO recordings (id, room_id, platform, stream_session_id, stream_title, state, started_at, ended_at, file_path, file_size_bytes, failure_reason, retry_count, quality, integrity, room_name, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, '', ?, '', 0, 'original', 'ok', ?, ?)`,
  );
  rows.forEach((r, i) => {
    insert.run(
      `rec-stats-${i}`,
      r.roomId ?? 'room-a',
      r.platform ?? 'bilibili',
      `sess-${i}`,
      r.state ?? 'completed',
      r.startedAt,
      r.endedAt === undefined ? r.startedAt : r.endedAt,
      r.bytes ?? 0,
      r.roomName ?? '房间A',
      r.startedAt,
    );
  });
}

const RANGE = { from: '2000-01-01T00:00:00.000Z', to: '2036-01-01T00:00:00.000Z' };

describe('stats aggregate（Q6=A 本地切日 + byRoom + SQL GROUP BY）', () => {
  it('本地 00:00–08:00 的录制归本地当日（C1；QA 矩阵新基线，UTC 口径作废）', () => {
    const services = newServices();
    // 2026-09-11T17:07:00Z = Asia/Shanghai 2026-09-12 01:07（UTC 日为 09-11，旧口径错位）。
    const iso = '2026-09-11T17:07:00.000Z';
    seed(services, [{ startedAt: iso, bytes: 100 }]);
    const body = aggregateStats(services, RANGE) as {
      byDay: Array<{ date: string; recordings: number; bytes: number; durationMs: number }>;
    };
    expect(localDay(iso)).toBe('2026-09-12');
    expect(body.byDay).toHaveLength(1);
    expect(body.byDay[0].date).toBe('2026-09-12');
    expect(body.byDay[0].date).not.toBe('2026-09-11'); // 与旧 UTC 切日结果相异，证明口径已切换
  });

  it('byDay 逐日与本地日复算一致，且日期全部落在取数范围内（C2/C3）', () => {
    const services = newServices();
    const rows: SeedRow[] = [
      { startedAt: '2026-03-01T16:30:00.000Z', bytes: 10 }, // 本地 03-02 00:30
      { startedAt: '2026-03-02T01:00:00.000Z', bytes: 20 }, // 本地 03-02 09:00
      { startedAt: '2026-03-02T15:59:59.999Z', bytes: 30 }, // 本地 03-02 23:59:59.999
      { startedAt: '2026-03-02T16:00:00.000Z', bytes: 40 }, // 本地 03-03 00:00
    ];
    seed(services, rows);
    const body = aggregateStats(services, RANGE) as {
      byDay: Array<{ date: string; recordings: number; bytes: number }>;
      totals: { recordings: number; bytes: number };
    };
    expect(body.byDay.map((d) => d.date)).toEqual(['2026-03-02', '2026-03-03']);
    expect(body.byDay[0].recordings).toBe(3);
    expect(body.byDay[0].bytes).toBe(60);
    expect(body.byDay[1].recordings).toBe(1);
    expect(body.byDay[1].bytes).toBe(40);
    expect(body.totals.recordings).toBe(4);
    expect(body.totals.bytes).toBe(100);
    // C3：每个日期 ∈ [from,to] 本地日集合（此处全部命中播种日期）。
    const validDays = new Set(rows.map((r) => localDay(r.startedAt)));
    for (const d of body.byDay) expect(validDays.has(d.date)).toBe(true);
  });

  it('小时闭区间取数：from/to 同一小时只含该小时，端点均含（A2，闭区间）', () => {
    const services = newServices();
    seed(services, [
      { startedAt: '2026-03-10T08:59:59.999Z', bytes: 1 }, // 前一秒：不含
      { startedAt: '2026-03-10T09:00:00.000Z', bytes: 2 }, // 起点：含
      { startedAt: '2026-03-10T09:59:59.999Z', bytes: 4 }, // 终点：含
      { startedAt: '2026-03-10T10:00:00.000Z', bytes: 8 }, // 后一秒：不含
    ]);
    const body = aggregateStats(services, { from: '2026-03-10T09:00:00.000Z', to: '2026-03-10T09:59:59.999Z' }) as {
      totals: { recordings: number; bytes: number };
      byDay: Array<{ date: string; recordings: number; bytes: number }>;
    };
    expect(body.totals.recordings).toBe(2);
    expect(body.totals.bytes).toBe(6);
    expect(body.byDay).toHaveLength(1);
    expect(body.byDay[0].recordings).toBe(2);
  });

  it('byRoom 契约：字段齐全、双/三指标齐备、最新 room_name 快照（G2 + QA bare-column 断言）', () => {
    const services = newServices();
    seed(services, [
      { startedAt: '2026-05-01T02:00:00.000Z', roomId: 'room-a', roomName: '旧名字', bytes: 100, endedAt: '2026-05-01T03:00:00.000Z' },
      { startedAt: '2026-05-02T02:00:00.000Z', roomId: 'room-a', roomName: '新名字', bytes: 200, endedAt: '2026-05-02T03:30:00.000Z' },
      { startedAt: '2026-05-03T02:00:00.000Z', roomId: 'room-b', roomName: '乙房间', bytes: 50, platform: 'douyin', endedAt: '2026-05-03T02:00:00.000Z' },
    ]);
    const body = aggregateStats(services, RANGE) as {
      byRoom: Array<{ roomId: string; roomName: string; recordings: number; durationMs: number; bytes: number }>;
      byPlatform: Array<{ platform: string; recordings: number; durationMs: number; bytes: number }>;
      totals: { durationMs: number };
    };
    expect(body.byRoom).toHaveLength(2);
    const a = body.byRoom.find((r) => r.roomId === 'room-a')!;
    const b = body.byRoom.find((r) => r.roomId === 'room-b')!;
    // 改名房间取最新快照（MAX(started_at) 所在行）。
    expect(a.roomName).toBe('新名字');
    expect(a.recordings).toBe(2);
    expect(a.bytes).toBe(300);
    expect(a.durationMs).toBe(150 * 60 * 1000); // 60min + 90min 两行求和
    expect(b.bytes).toBe(50);
    // 平台分组结构不变 + 首现顺序（bilibili 先）。
    expect(body.byPlatform.map((p) => p.platform)).toEqual(['bilibili', 'douyin']);
    for (const p of body.byPlatform) expect(typeof p.durationMs).toBe('number');
    // totals 时长 = 各行 JS Date diff 精确求和。
    expect(body.totals.durationMs).toBe(60 * 60 * 1000 + 90 * 60 * 1000 + 0);
  });

  it('durationMs 精确到毫秒且与 JS Date diff 一致；进行中（ended_at NULL）计 0（B4）', () => {
    const services = newServices();
    seed(services, [
      { startedAt: '2026-08-27T09:00:00.123Z', endedAt: '2026-08-27T10:00:00.456Z', bytes: 1 },
      { startedAt: '2026-08-27T11:00:00.000Z', endedAt: null, bytes: 1 }, // 进行中
      { startedAt: '2026-08-27T12:00:00.000Z', endedAt: '2026-08-27T11:00:00.000Z', bytes: 1 }, // 异常倒挂 → 0
    ]);
    const jsExact = new Date('2026-08-27T10:00:00.456Z').getTime() - new Date('2026-08-27T09:00:00.123Z').getTime();
    expect(jsExact).toBe(3_600_333);
    const body = aggregateStats(services, RANGE) as { totals: { durationMs: number } };
    expect(body.totals.durationMs).toBe(jsExact); // 精确相等（ROUND 到 ms 后）
  });

  it('0 字节历史录制按 0 计入（Q5/E1）；totals/byDay/byPlatform/byRoom 字段结构只加不改', () => {
    const services = newServices();
    seed(services, [
      { startedAt: '2026-09-01T01:00:00.000Z', bytes: 0 },
      { startedAt: '2026-09-01T02:00:00.000Z', bytes: null },
    ]);
    const body = aggregateStats(services, RANGE) as Record<string, unknown>;
    expect(body.totals).toEqual({ recordings: 2, completed: 2, failed: 0, durationMs: 0, bytes: 0, successRate: 100 });
    expect(Object.keys(body.totals)).toEqual(['recordings', 'completed', 'failed', 'durationMs', 'bytes', 'successRate']);
    expect(Object.keys((body.byDay as unknown[])[0] as object)).toEqual(['date', 'recordings', 'durationMs', 'bytes']);
    expect(Object.keys((body.byPlatform as unknown[])[0] as object)).toEqual(['platform', 'recordings', 'durationMs', 'bytes']);
    expect(Object.keys((body.byRoom as unknown[])[0] as object)).toEqual(['roomId', 'roomName', 'recordings', 'durationMs', 'bytes']);
    expect(Object.keys(body)).toEqual(['from', 'to', 'totals', 'byDay', 'byPlatform', 'byRoom', 'generatedAt']);
  });

  it('标签多选（逗号 tagId）与平台/房间筛选作用于全部四组聚合（A3）', () => {
    const services = newServices();
    seed(services, [
      { startedAt: '2026-06-01T02:00:00.000Z', roomId: 'room-a', bytes: 10 },
      { startedAt: '2026-06-01T03:00:00.000Z', roomId: 'room-b', bytes: 20, platform: 'douyin' },
      { startedAt: '2026-06-01T04:00:00.000Z', roomId: 'room-c', bytes: 40, platform: 'douyin' },
    ]);
    services.db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').run('t1', '标签一');
    services.db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)').run('t2', '标签二');
    services.db.prepare('INSERT INTO room_tags (room_id, tag_id) VALUES (?, ?)').run('room-b', 't1');
    services.db.prepare('INSERT INTO room_tags (room_id, tag_id) VALUES (?, ?)').run('room-c', 't2');

    const byTag = aggregateStats(services, { ...RANGE, tagId: 't1,t2' }) as {
      totals: { recordings: number; bytes: number };
      byRoom: unknown[];
      byPlatform: Array<{ platform: string; recordings: number }>;
    };
    expect(byTag.totals.recordings).toBe(2);
    expect(byTag.totals.bytes).toBe(60);
    expect(byTag.byRoom).toHaveLength(2);
    expect(byTag.byPlatform).toHaveLength(1);
    expect(byTag.byPlatform[0].platform).toBe('douyin');

    const byRoom = aggregateStats(services, { ...RANGE, roomId: 'room-a' }) as { totals: { recordings: number }; byRoom: unknown[] };
    expect(byRoom.totals.recordings).toBe(1);
    expect(byRoom.byRoom).toHaveLength(1);
  });

  it('365 天区间 10 万行聚合耗时 < 500ms（宽松阈值防回归；QA F1 实测 10 万条 p95<200ms）', () => {
    const services = newServices();
    const insert = services.db.prepare(
      `INSERT INTO recordings (id, room_id, platform, stream_session_id, stream_title, state, started_at, ended_at, file_path, file_size_bytes, failure_reason, retry_count, quality, integrity, room_name, created_at)
       VALUES (?, ?, ?, ?, '', 'completed', ?, ?, '', ?, '', 0, 'original', 'ok', ?, ?)`,
    );
    const base = Date.parse('2025-09-22T00:00:00.000Z');
    const stepMs = Math.floor((364 * 24 * 3600 * 1000) / 100_000); // 均匀铺满 365 天
    const platforms = ['bilibili', 'douyin'];
    services.db.exec('BEGIN');
    for (let i = 0; i < 100_000; i++) {
      const start = new Date(base + i * stepMs).toISOString();
      const end = new Date(base + i * stepMs + 60_000 + (i % 1000)).toISOString();
      insert.run(`bulk-${i}`, `room-${i % 50}`, platforms[i % 2], `s-${i}`, start, end, (i % 7) * 1024, `房间${i % 50}`, start);
    }
    services.db.exec('COMMIT');

    const opts = { from: new Date(base).toISOString(), to: new Date(base + 365 * 24 * 3600 * 1000).toISOString() };
    // 预热 1 次（编译语句 + 缓存路径），随后取 5 次最大耗时。
    aggregateStats(services, opts);
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      services.statsCache = undefined; // 绕开 5s 缓存，测真实聚合
      const t0 = performance.now();
      const body = aggregateStats(services, opts) as { totals: { recordings: number }; byDay: unknown[] };
      worst = Math.max(worst, performance.now() - t0);
      expect(body.totals.recordings).toBe(100_000);
      expect(body.byDay.length).toBeGreaterThanOrEqual(360);
    }
    expect(worst).toBeLessThan(500);
  }, 30_000);
});
