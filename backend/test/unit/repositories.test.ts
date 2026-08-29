import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.ts';
import { currentSchemaVersion, MIGRATIONS, runMigrations } from '../../src/db/migrations/index.ts';
import { RoomRepository } from '../../src/db/repositories/room.repo.ts';
import { RecordingRepository } from '../../src/db/repositories/recording.repo.ts';
import { SettingsRepository } from '../../src/db/repositories/settings.repo.ts';
import { AlertRepository } from '../../src/db/repositories/alert.repo.ts';
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
    expect(runMigrations(db)).toBe(11);
    expect(runMigrations(db)).toBe(0);
    expect(currentSchemaVersion(db)).toBe(11);
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

    // 跑完整迁移：v2 被跳过（已记录），v3 幂等补列、v4 加 integrity 列、v8 重建 recordings（去外键+room_name），v9-v11 新增 V5 表列
    expect(runMigrations(db)).toBe(9);
    const colsAfter = (db.prepare(`SELECT name FROM pragma_table_info('rooms')`).all() as { name: string }[]).map((c) => c.name);
    expect(colsAfter).toContain('favorited');
    expect(colsAfter).toContain('upload_enabled');
    expect(currentSchemaVersion(db)).toBe(11);

    // 再次运行不再补列也不报错（幂等）
    expect(runMigrations(db)).toBe(0);
    db.prepare(`INSERT INTO rooms (id, platform, url, favorited) VALUES ('r2', 'bilibili', 'https://live.bilibili.com/2', 1)`).run();
    expect((db.prepare('SELECT favorited FROM rooms WHERE id = ?').get('r2') as { favorited: number }).favorited).toBe(1);
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
});
