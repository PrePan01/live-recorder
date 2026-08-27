import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.ts';
import { currentSchemaVersion, runMigrations } from '../../src/db/migrations/index.ts';
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
    expect(runMigrations(db)).toBe(1);
    expect(runMigrations(db)).toBe(0);
    expect(currentSchemaVersion(db)).toBe(1);
    db.prepare(`INSERT INTO rooms (id, platform, url) VALUES ('r1', 'bilibili', 'https://live.bilibili.com/1')`).run();
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS c FROM rooms').get() as { c: number }).c).toBe(1);
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
});

describe('RecordingRepository', () => {
  it('paginates, filters and dedups by session', async () => {
    const db = freshDb();
    const rooms = new RoomRepository(db);
    const recs = new RecordingRepository(db);
    const room = rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9', displayName: 'x' });
    const a = recs.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's1', streamTitle: 't1' });
    recs.update(a.id, { state: 'recording' });
    expect(recs.hasSession(room.id, 's1')).toBe(true);
    await new Promise((r) => setTimeout(r, 2));
    const b = recs.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's2', streamTitle: 't2' });
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
