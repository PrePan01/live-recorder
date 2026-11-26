import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrations/index.js';
import { CHINESE_LIVE_COOKIE_KEYS } from '../../src/security/keys.js';

const headers = { host: '127.0.0.1:43120' };

describe('Douyu and Huya application integration', () => {
  it('accepts both platforms in room management and restores their rooms and settings from backup', async () => {
    const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
    const { app } = buildApp(services);
    const restored = buildServices({ dbPath: ':memory:', mode: 'fake' });
    const restoredApp = buildApp(restored).app;
    try {
      const batch = await app.inject({ method: 'POST', url: '/api/v1/rooms/batch', headers, payload: { urls: [
        'https://m.douyu.com/topic/event?rid=42',
        'https://www.douyu.com/42',
        'https://m.huya.com/98',
        'https://www.huya.com/search',
      ] } });
      expect(batch.json().succeeded).toEqual([
        expect.objectContaining({ platform: 'douyu', url: 'https://www.douyu.com/42' }),
        expect.objectContaining({ platform: 'huya', url: 'https://www.huya.com/98' }),
      ]);
      expect(batch.json().failed).toHaveLength(2);
      for (const room of services.rooms.list()) {
        const rec = services.recordings.create({
          roomId: room.id, roomName: '主播', platform: room.platform, streamSessionId: null, streamTitle: '已录制',
        });
        services.recordings.update(rec.id, { state: 'completed', endedAt: new Date().toISOString(), fileSizeBytes: 42 });
      }
      const settings = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload: {
        recordingDirectory: tmpdir(), checkIntervalSec: { huya: 123 },
      } });
      expect(settings.statusCode).toBe(200);
      const backup = await app.inject({ url: '/api/v1/config/export', headers });
      const config = backup.json().config;
      const result = await restoredApp.inject({ method: 'POST', url: '/api/v1/config/import', headers, payload: { config } });
      expect(result.statusCode).toBe(200);
      expect(new Set(restored.rooms.list().map(room => room.platform))).toEqual(new Set(['douyu', 'huya']));
      expect(new Set(restored.recordings.list().items.map(record => record.platform))).toEqual(new Set(['douyu', 'huya']));
      expect(restored.settings.load()?.checkIntervalSec).toMatchObject({ douyu: 60, huya: 123 });
    } finally {
      await app.close();
      await restoredApp.close();
    }
  });

  it('stores credentials separately, publishes presence only, and clears through settings', async () => {
    const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
    const { app } = buildApp(services);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 0, data: [] }));
    try {
      const stored = await app.inject({ method: 'POST', url: '/api/v1/settings/douyu-cookie', headers, payload: { cookie: 'acf_auth=private-test' } });
      expect(stored.statusCode).toBe(200);
      expect(stored.json().settings.douyuCookie).toEqual({ hasCookie: true });
      expect((await app.inject({ url: '/api/v1/settings/douyu-cookie-status', headers })).json()).toEqual({ status: 'valid' });
      expect(await services.platformCookie('douyu')).toBe('acf_auth=private-test');
      expect(services.settings.load() ?? {}).not.toHaveProperty('douyuCookie');
      expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload: { huyaCookie: 'yyuid=42; passwordToken=private-huya' } })).statusCode).toBe(200);
      expect(await services.secretStore.get(CHINESE_LIVE_COOKIE_KEYS.huya)).toContain('private-huya');
      const backup = await app.inject({ url: '/api/v1/config/export', headers });
      expect(backup.body).not.toMatch(/private-test|private-huya/);
      const cleared = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload: { douyuCookie: '', huyaCookie: '' } });
      expect(cleared.json().settings).toMatchObject({ douyuCookie: { hasCookie: false }, huyaCookie: { hasCookie: false } });
      expect((await app.inject({ url: '/api/v1/settings/douyu-cookie-status', headers })).json()).toEqual({ status: 'missing' });
    } finally {
      fetcher.mockRestore();
      await app.close();
    }
  });

  it('upgrades a v58 database with existing recordings, FK children and custom schema objects', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
      for (const migration of MIGRATIONS.filter(migration => migration.version <= 58)) {
        if (migration.up) migration.up(db);
        else if (migration.sql) db.exec(migration.sql);
        db.prepare('INSERT INTO schema_version VALUES (?)').run(migration.version);
      }
      db.exec(`
        INSERT INTO rooms(id,platform,url) VALUES ('r','youtube','https://www.youtube.com/@example');
        INSERT INTO recordings(id,room_id,room_name,platform,state,started_at)
          VALUES ('history','r','example','youtube','completed','2026-01-01');
        CREATE INDEX idx_upgrade_room_url ON rooms(url);
        CREATE TABLE upgrade_child(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE);
        INSERT INTO upgrade_child VALUES ('r');
        CREATE TRIGGER upgrade_room_insert AFTER INSERT ON rooms BEGIN
          INSERT INTO upgrade_child VALUES (new.id);
        END;
      `);
      expect(runMigrations(db)).toBe(1);
      expect(runMigrations(db)).toBe(0);
      expect(db.prepare('SELECT room_id FROM recordings WHERE id=?').get('history')).toEqual({ room_id: 'r' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_upgrade_room_url'").get()).toBeTruthy();
      db.exec("INSERT INTO rooms(id,platform,url) VALUES ('d','douyu','https://www.douyu.com/42'), ('h','huya','https://www.huya.com/98')");
      expect(db.prepare('SELECT COUNT(*) AS n FROM upgrade_child').get()).toEqual({ n: 3 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
