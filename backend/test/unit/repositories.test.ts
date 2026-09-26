import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.ts';
import { currentSchemaVersion, MIGRATIONS, runMigrations } from '../../src/db/migrations/index.ts';
import { RoomRepository } from '../../src/db/repositories/room.repo.ts';
import { RecordingRepository } from '../../src/db/repositories/recording.repo.ts';
import { SettingsRepository } from '../../src/db/repositories/settings.repo.ts';
import { AlertRepository } from '../../src/db/repositories/alert.repo.ts';
import { PredictionCalibrationRepository } from '../../src/db/repositories/prediction-calibration.repo.ts';
import { AppError } from '../../src/types/error.ts';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('migrations', () => {
  it('is idempotent and records schema_version', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toBe(40);
    expect(runMigrations(db)).toBe(0);
    expect(currentSchemaVersion(db)).toBe(40);
    db.prepare(`INSERT INTO rooms (id, platform, url) VALUES ('r1', 'bilibili', 'https://live.bilibili.com/1')`).run();
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rooms').get() as { c: number }).c).toBe(1);
  });

  it('v3 idempotently backfills favorited on a DB that skipped v2 (task #39)', () => {
    // 模拟存量库：仅应用 v1，且手工把 schema_version 记为 2（对应早前撞号的 v2），但 rooms 表无 favorited 列。
    const db = openDatabase(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map((r: unknown) => (r as { version: number }).version));
    for (const m of MIGRATIONS.filter((m) => m.version <= 1)) {
      if (applied.has(m.version)) continue;
      db.transaction(() => {
        if (m.up) m.up(db);
        else if (m.sql) db.exec(m.sql);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
      })();
    }
    // 伪造：schema_version 已有 2，但 favorited 列从未加过（模拟撞号被跳过的库）
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    const colsBefore = (db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all() as { name: string }[]).map((c) => c.name);
    expect(colsBefore).not.toContain('favorited');

    // 跑完整迁移：v2 被跳过（已记录），v3 幂等补列、v4 加 integrity 列、v8 重建 recordings（去外键+room_name），v9-v11 新增 V5 表列，v12 管线表
    expect(runMigrations(db)).toBe(38);
    const colsAfter = (db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all() as { name: string }[]).map((c) => c.name);
    expect(colsAfter).toContain('favorited');
    expect(colsAfter).toContain('upload_enabled');
    expect(currentSchemaVersion(db)).toBe(40);

    // 再次运行不再补列也不报错（幂等）
    expect(runMigrations(db)).toBe(0);
    db.prepare(`INSERT INTO rooms (id, platform, url, favorited) VALUES ('r2', 'bilibili', 'https://live.bilibili.com/2', 1)`).run();
    expect((db.prepare('SELECT favorited FROM rooms WHERE id = ?').get('r2') as { favorited: number }).favorited).toBe(1);
  });

  it('v16 backfills all ALTER-added columns on a DB that skipped amended v9 (QA 抖音卡检测生产缺陷)', () => {
    // 模拟存量库：仅应用 v1-v8，且 schema_version 伪造记录到 15——对应 v9 曾以不含 title_* 的旧定义
    // 落库后版本号已记录、后续迁移被跳过，rooms 表缺 title_*/upload_enabled 列的场景。
    const db = openDatabase(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    for (const m of MIGRATIONS.filter((m) => m.version <= 8)) {
      if (m.up) m.up(db);
      else if (m.sql) db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    for (let v = 9; v <= 15; v += 1) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);

    const roomsCols = (db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all() as { name: string }[]).map((c) => c.name);
    expect(roomsCols).not.toContain('title_source');
    expect(roomsCols).not.toContain('title_updated_at');
    expect(roomsCols).not.toContain('title_fallback_used');
    expect(roomsCols).not.toContain('upload_enabled');

    // 仅 v16 及之后未应用：补齐缺失列和追加索引并可用 repo 正常读写。
    expect(runMigrations(db)).toBe(25);
    const after = (db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all() as { name: string }[]).map((c) => c.name);
    expect(after).toContain('title_source');
    expect(after).toContain('title_updated_at');
    expect(after).toContain('title_fallback_used');
    expect(after).toContain('upload_enabled');
    expect(after).toContain('current_stream_title');
    expect(after).toContain('available_qualities');

    const repo = new RoomRepository(db);
    const room = repo.create({ platform: 'douyin', url: 'https://live.douyin.com/405783317287', displayName: '' });
    repo.setTitleInfo(room.id, { titleSource: 'adapter', titleFallbackUsed: false });
    expect(repo.get(room.id)!.titleSource).toBe('adapter');

    expect(currentSchemaVersion(db)).toBe(40);
    expect(runMigrations(db)).toBe(0);
  });

  it('v19 ensures expected_quality on a DB where schema_version=18 recorded but column missing (QA #3 阻断回归)', () => {
    // 模拟存量库：v1-v17 正常应用，schema_version 伪造记录 18（早前 WIP 迁移被记录但 ALTER 未落库），recordings 表缺 expected_quality 列。
    const db = openDatabase(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    for (const m of MIGRATIONS.filter((m) => m.version <= 17)) {
      if (m.up) m.up(db);
      else if (m.sql) db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    }
    // 伪造：schema_version 已有 18，但 expected_quality 列从未加过（模拟早前 WIP 迁移被记录后 ALTER 未生效）。
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(18);
    const colsBefore = (db.prepare(`SELECT name FROM pragma_table_info('recordings')`).all() as { name: string }[]).map((c) => c.name);
    expect(colsBefore).not.toContain('expected_quality');

    // v19 补列，v20 追加索引，v21 增加直播间顺序，v22 增加上传清理资格列。
    expect(runMigrations(db)).toBe(22);
    const colsAfter = (db.prepare(`SELECT name FROM pragma_table_info('recordings')`).all() as { name: string }[]).map((c) => c.name);
    expect(colsAfter).toContain('expected_quality');

    // 补列后 recordings.create 带 expectedQuality 可正常落库（此前会 no such column）。
    const repo = new RoomRepository(db);
    const room = repo.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9988', displayName: '回归' });
    const recs = new RecordingRepository(db);
    const rec = recs.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's9', streamTitle: '回归录制', quality: '720p', expectedQuality: '360p' });
    expect(recs.get(rec.id)!.quality).toBe('720p');
    expect(recs.get(rec.id)!.expectedQuality).toBe('360p');

    expect(currentSchemaVersion(db)).toBe(40);
    expect(runMigrations(db)).toBe(0);
  });

  it('v21 backfills the previous created-desc room order', () => {
    const db = openDatabase(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 20)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    db.prepare(`INSERT INTO rooms (id, platform, url, created_at, updated_at) VALUES (?, 'bilibili', ?, ?, ?)`)
      .run('old', 'https://live.bilibili.com/1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    db.prepare(`INSERT INTO rooms (id, platform, url, created_at, updated_at) VALUES (?, 'bilibili', ?, ?, ?)`)
      .run('new', 'https://live.bilibili.com/2', '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z');
    MIGRATIONS.find((item) => item.version === 21)!.up!(db);
    expect(new RoomRepository(db).list().map((room) => room.id)).toEqual(['new', 'old']);
    expect((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_rooms_sort_order'`).get() as { name: string }).name).toBe('idx_rooms_sort_order');
  });

  it('v22 adds a false-by-default cleanup flag to existing upload jobs', () => {
    const db = openDatabase(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 21)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    db.exec(`INSERT INTO upload_jobs (id, recording_id, idempotency_key) VALUES ('upl-old', 'rec-old', 'rec_old')`);
    MIGRATIONS.find((item) => item.version === 22)!.up!(db);
    expect(db.prepare(`SELECT delete_source_after_success FROM upload_jobs WHERE id = 'upl-old'`).get()).toEqual({ delete_source_after_success: 0 });
  });

  it('v23 adds a false-by-default live notification flag to existing rooms', () => {
    const db = openDatabase(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 22)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    db.prepare(`INSERT INTO rooms (id, platform, url) VALUES ('room-old', 'bilibili', 'https://live.bilibili.com/99')`).run();
    MIGRATIONS.find((item) => item.version === 23)!.up!(db);
    // 当前仓库写路径含 v38 的 avatar_url 列：补跑后再用仓库（与本测试断言的 v23 标志无关）。
    MIGRATIONS.find((item) => item.version === 38)!.up!(db);
    const rooms = new RoomRepository(db);
    expect(rooms.get('room-old')!.liveNotificationEnabled).toBe(false);
    expect(rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/100', displayName: '新房间' }).liveNotificationEnabled).toBe(false);
    expect(rooms.update('room-old', { liveNotificationEnabled: true }).liveNotificationEnabled).toBe(true);
  });

  it('v24 adds detector-owned live event history', () => {
    const db = openDatabase(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 23)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    MIGRATIONS.find((item) => item.version === 24)!.up!(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_events'`).get()).toBeTruthy();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_live_events_room_detected'`).get()).toBeTruthy();
  });

  it('v30 keeps one local forecast per room-day-window and retains coverage separately', () => {
    const db = freshDb();
    const calibration = new PredictionCalibrationRepository(db);
    calibration.recordForecast({ roomId: 'room_1', targetDate: '2026-09-14', probability: 'low', rawProbability: 'medium', windowStartAt: '2026-09-14T08:00:00.000Z', windowEndAt: '2026-09-14T09:00:00.000Z', generatedAt: '2026-09-13T16:00:00.000Z' });
    calibration.recordForecast({ roomId: 'room_1', targetDate: '2026-09-14', probability: 'high', rawProbability: 'high', windowStartAt: '2026-09-14T20:00:00.000Z', windowEndAt: '2026-09-14T21:00:00.000Z', generatedAt: '2026-09-13T17:00:00.000Z' });
    expect(calibration.recordForecast({ roomId: 'room_1', targetDate: '2026-09-14', probability: 'high', rawProbability: 'high', windowStartAt: '2026-09-14T20:00:00.000Z', windowEndAt: '2026-09-14T21:00:00.000Z', generatedAt: '2026-09-13T18:00:00.000Z' })).toBe(false);
    calibration.recordCoverage('room_1', '2026-09-14', '2026-09-14T00:00:00.000Z');
    calibration.recordCoverage('room_1', '2026-09-14', '2026-09-14T04:00:00.000Z');
    const forecast = calibration.pendingBefore('2026-09-15');
    expect(forecast).toHaveLength(2);
    expect(forecast[0]).toMatchObject({ probability: 'low', rawProbability: 'medium' });
    expect(calibration.coverage('room_1', '2026-09-14')).toMatchObject({ checks: 2, firstCheckedAt: '2026-09-14T00:00:00.000Z', lastCheckedAt: '2026-09-14T04:00:00.000Z' });
    calibration.resolve(forecast[0]!.id, 'hit', '2026-09-15T00:00:00.000Z');
    expect(calibration.profiles(['room_1'], '2026-08-01').get('room_1')).toEqual({ medium: { hits: 1, total: 1 } });
  });

  it('v30 preserves existing calibration rows while allowing another window on the same day', () => {
    const db = openDatabase(':memory:');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 29)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    const calibration = new PredictionCalibrationRepository(db);
    calibration.recordForecast({ roomId: 'room_1', targetDate: '2026-09-14', probability: 'low', rawProbability: 'medium', windowStartAt: '2026-09-14T08:00:00.000Z', windowEndAt: '2026-09-14T09:00:00.000Z', generatedAt: '2026-09-13T16:00:00.000Z' });
    MIGRATIONS.find((item) => item.version === 30)!.up!(db);
    expect(calibration.recordForecast({ roomId: 'room_1', targetDate: '2026-09-14', probability: 'low', rawProbability: 'medium', windowStartAt: '2026-09-14T20:00:00.000Z', windowEndAt: '2026-09-14T21:00:00.000Z', generatedAt: '2026-09-13T17:00:00.000Z' })).toBe(true);
    expect(calibration.pendingBefore('2026-09-15')).toHaveLength(2);
    db.close();
  });

  it('v32 strips legacy error-code prefixes from stored alert messages', () => {
    const db = openDatabase(':memory:');
    // 39=alerts.retryable：repo INSERT 依赖此列，子集建库需一并应用。
    for (const migration of MIGRATIONS.filter((item) => item.version <= 31 || item.version === 39)) {
      if (migration.up) migration.up(db);
      else if (migration.sql) db.exec(migration.sql);
    }
    const alerts = new AlertRepository(db);
    const prefixed = alerts.create({ level: 'warning', source: 'platform', message: 'PLATFORM_ACCESS_RESTRICTED: 平台访问受限，请检查B站授权', occurredAt: '2026-09-17T00:00:00.000Z', errorCode: 'PLATFORM_ACCESS_RESTRICTED' });
    const plain = alerts.create({ level: 'warning', source: 'smtp', message: 'SMTP 通知发送失败（live_started）', occurredAt: '2026-09-17T00:00:00.000Z' });
    MIGRATIONS.find((item) => item.version === 32)!.up!(db);
    expect(alerts.get(prefixed.id)!.message).toBe('平台访问受限，请检查B站授权');
    expect(alerts.get(prefixed.id)!.errorCode).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(alerts.get(plain.id)!.message).toBe('SMTP 通知发送失败（live_started）');
    db.close();
  });
});

describe('AlertRepository', () => {
  it('refreshes a continuing unresolved error instead of adding a row for every polling cycle', () => {
    const db = freshDb();
    const alerts = new AlertRepository(db);
    const first = alerts.createOrRefresh({ level: 'error', source: 'platform', message: '抖音：抖音接口暂时不可用，请稍后重试', occurredAt: '2026-09-20T00:00:00.000Z', errorCode: 'NETWORK_UNAVAILABLE' });
    const refreshed = alerts.createOrRefresh({ level: 'error', source: 'platform', message: '抖音：抖音接口暂时不可用，请稍后重试', occurredAt: '2026-09-20T00:02:00.000Z', errorCode: 'NETWORK_UNAVAILABLE' });

    expect(refreshed.id).toBe(first.id);
    expect(alerts.list({ unresolvedOnly: true })).toHaveLength(1);
    expect(alerts.get(first.id)!.occurredAt).toBe('2026-09-20T00:02:00.000Z');
    alerts.markResolved(first.id);
    expect(alerts.createOrRefresh({ level: 'error', source: 'platform', message: '抖音：抖音接口暂时不可用，请稍后重试', occurredAt: '2026-09-20T00:03:00.000Z', errorCode: 'NETWORK_UNAVAILABLE' }).id).not.toBe(first.id);
    db.close();
  });
});

describe('SettingsRepository compatibility', () => {
  it('keeps the historical enabled default for an existing settings record without autoRecord', () => {
    const db = freshDb();
    const settings = new SettingsRepository(db);
    const legacy = { ...DEFAULT_SETTINGS, recordingDirectory: '/tmp/recordings' } as Record<string, unknown>;
    delete legacy.autoRecord;
    settings.setRaw('settings', JSON.stringify(legacy));

    expect(settings.load()?.autoRecord).toBe(true);
    db.close();
  });
});

describe('RoomRepository', () => {
  it('creates and dedups by UNIQUE(platform, url)', () => {
    const rooms = new RoomRepository(freshDb());
    const room = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: '主播' });
    expect(room.id.startsWith('room_')).toBe(true);
    expect(room.monitorState).toBe('idle');
    expect(() => rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: '重复' })).toThrowError(AppError);
    try {
      rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: '重复' });
    } catch (err) {
      expect((err as AppError).code).toBe('ROOM_LINK_DUPLICATE');
    }
  });

  it('round-trips structured lastError and toggles disabled state', () => {
    const rooms = new RoomRepository(freshDb());
    const room = rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/1', displayName: 'd' });
    const err = new AppError('PLATFORM_ACCESS_RESTRICTED', '平台访问受限', { roomId: room.id });
    rooms.setState(room.id, 'failed', { lastCheckedAt: err.occurredAt, lastError: err.toObject() });
    const loaded = rooms.get(room.id)!;
    expect(loaded.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(loaded.lastError?.retryable).toBe(false);
    const toggled = rooms.update(room.id, { enabled: false });
    expect(toggled.monitorState).toBe('disabled');
    expect(rooms.listEnabled()).toHaveLength(0);
    const re = rooms.update(room.id, { enabled: true });
    expect(re.monitorState).toBe('idle');
  });

  it('persists favorited flag and defaults activeRecording to null', () => {
    const rooms = new RoomRepository(freshDb());
    const room = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/789', displayName: '收藏' });
    expect(room.favorited).toBe(false);
    expect(room.activeRecording).toBeNull();

    const fav = rooms.setFavorite(room.id, true);
    expect(fav.favorited).toBe(true);
    expect(rooms.get(room.id)!.favorited).toBe(true);

    const un = rooms.setFavorite(room.id, false);
    expect(un.favorited).toBe(false);
    expect(() => rooms.setFavorite('room_none', true)).toThrowError(AppError);
    try {
      rooms.setFavorite('room_none', true);
    } catch (err) {
      expect((err as AppError).code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('places new rooms first and atomically persists complete custom orders', () => {
    const rooms = new RoomRepository(freshDb());
    const first = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/201', displayName: '一' });
    const second = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/202', displayName: '二' });
    const third = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/203', displayName: '三' });
    expect(rooms.list().map((room) => room.id)).toEqual([third.id, second.id, first.id]);

    rooms.reorder([first.id, third.id, second.id]);
    expect(rooms.list().map((room) => room.id)).toEqual([first.id, third.id, second.id]);
    expect(() => rooms.reorder([third.id, third.id, second.id])).toThrowError(AppError);
    expect(rooms.list().map((room) => room.id)).toEqual([first.id, third.id, second.id]);
  });
});

describe('RecordingRepository', () => {
  it('paginates, filters and dedups by session', async () => {
    const db = freshDb();
    const rooms = new RoomRepository(db);
    const recs = new RecordingRepository(db);
    const room = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9', displayName: 'x' });
    const a = recs.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's1', streamTitle: 't1' });
    recs.update(a.id, { state: 'recording' });
    expect(recs.hasSession(room.id, 's1')).toBe(true);
    await new Promise((r) => setTimeout(r, 2));
    const b = recs.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's2', streamTitle: 't2' });
    recs.update(b.id, {
      state: 'failed',
      endedAt: new Date().toISOString(),
      failureReason: new AppError('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED', '断流重连耗尽', { roomId: room.id, recordingId: b.id, retryable: true }).toObject(),
      retryCount: 3,
    });
    expect(recs.hasSession(room.id, 's2')).toBe(false);
    const page = recs.list({ pageSize: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.failureReason?.code).toBe('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED');
    expect(page.items[0]!.retryCount).toBe(3);
    expect(recs.list({ state: 'recording' }).items).toHaveLength(1);
    expect(recs.activeCount()).toBe(1);
  });

  it('persists and outputs integrity field (verified/failed/pending)', () => {
    const db = freshDb();
    const rooms = new RoomRepository(db);
    const recs = new RecordingRepository(db);
    const room = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/6', displayName: 'i' });
    const rec = recs.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'si', streamTitle: 'i' });
    expect(rec.integrity).toBeUndefined();
    recs.update(rec.id, { state: 'completed', integrity: 'verified' });
    expect(recs.get(rec.id)!.integrity).toBe('verified');
    recs.update(rec.id, { integrity: 'failed' });
    expect(recs.get(rec.id)!.integrity).toBe('failed');
    expect(recs.list({ roomId: room.id }).items[0]!.integrity).toBe('failed');
  });

  it('snapshots roomName on create and keeps recordings after room removal (#92)', () => {
    const db = freshDb();
    const rooms = new RoomRepository(db);
    const recs = new RecordingRepository(db);
    const room = rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/92', displayName: '抖音主播' });
    const rec = recs.create({ roomId: room.id, roomName: room.displayName, platform: 'douyin', streamSessionId: 'd92', streamTitle: 't' });
    expect(recs.get(rec.id)!.roomName).toBe('抖音主播');

    // 删房间不再级联删录制历史，且外键已移除（可成功删除）。
    rooms.remove(room.id);
    expect(rooms.get(room.id)).toBeNull();
    const kept = recs.get(rec.id);
    expect(kept).not.toBeNull();
    expect(kept!.roomId).toBe(room.id);
    expect(kept!.roomName).toBe('抖音主播');
    expect(recs.list({ roomId: room.id }).items).toHaveLength(1);
  });
});

describe('SettingsRepository', () => {
  it('never persists mail password', () => {
    const settings = new SettingsRepository(freshDb());
    settings.save({
      ...DEFAULT_SETTINGS,
      recordingDirectory: '/tmp/vids',
      mail: { ...DEFAULT_SETTINGS.mail, host: 'smtp.x.com' } as never,
    });
    expect(settings.getRaw('settings')).not.toContain('password');
    const loaded = settings.load()!;
    expect(loaded.recordingDirectory).toBe('/tmp/vids');
    expect(loaded.checkIntervalSec.douyin).toBe(120);
  });
});

describe('AlertRepository', () => {
  it('creates, lists unresolved and marks read', () => {
    const alerts = new AlertRepository(freshDb());
    const alr = alerts.create({ level: 'warning', source: 'disk', message: '磁盘空间不足', occurredAt: new Date().toISOString() });
    expect(alr.id.startsWith('alr_')).toBe(true);
    expect(alerts.list({ unresolvedOnly: true })).toHaveLength(1);
    alerts.markResolved(alr.id);
    expect(alerts.list({ unresolvedOnly: true })).toHaveLength(0);
    alerts.create({ level: 'info', source: 'recorder', message: '清晰度降级', occurredAt: new Date().toISOString() });
    expect(alerts.markAllResolved()).toBe(1);
  });

  it('resolves only the given room\u2019s unresolved platform alerts, leaving platform-wide ones intact', () => {
    // 一次瞬时误报会留下未读告警；检测恢复后应连同该房间的告警一起消解，而平台级告警（无房间）必须保留。
    const alerts = new AlertRepository(freshDb());
    const roomAlert = alerts.create({ level: 'error', source: 'platform', message: '平台接口有变动，请稍后重试', occurredAt: '2026-09-20T00:00:00.000Z', roomId: 'room_a', errorCode: 'PLATFORM_CHANGED' });
    const otherRoom = alerts.create({ level: 'error', source: 'platform', message: '平台接口有变动，请稍后重试', occurredAt: '2026-09-20T00:00:00.000Z', roomId: 'room_b', errorCode: 'PLATFORM_CHANGED' });
    const recorderAlert = alerts.create({ level: 'error', source: 'recorder', message: '录制启动失败', occurredAt: '2026-09-20T00:00:00.000Z', roomId: 'room_a', errorCode: 'RECORDING_START_FAILED' });
    const platformWide = alerts.create({ level: 'warning', source: 'platform', message: '抖音授权已失效，请到设置页重新授权', occurredAt: '2026-09-20T00:00:00.000Z', errorCode: 'DOUYIN_COOKIE_EXPIRED' });

    const resolved = alerts.resolveForRoom('room_a', 'platform');

    expect(resolved.map((a) => a.id)).toEqual([roomAlert.id]);
    expect(resolved[0]!.resolved).toBe(true);
    expect(alerts.get(roomAlert.id)!.resolved).toBe(true);
    expect(alerts.get(otherRoom.id)!.resolved).toBe(false);
    expect(alerts.get(recorderAlert.id)!.resolved).toBe(false);
    expect(alerts.get(platformWide.id)!.resolved).toBe(false);
    expect(alerts.resolveForRoom('room_a', 'platform')).toHaveLength(0);
  });

  it('uses WAL + synchronous NORMAL pairing（常驻写入型进程的 fsync 减负）', async () => {
    // :memory: 不支持 WAL（journal_mode 返回 memory），必须用临时文件库验证生产路径
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-prag-'));
    const db = openDatabase(path.join(dir, 'x.db'));
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal');
    // 1=NORMAL（未设置时默认 2=FULL；WAL 标准配对为 NORMAL，掉电安全边界仍由 WAL 保证）
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

});
