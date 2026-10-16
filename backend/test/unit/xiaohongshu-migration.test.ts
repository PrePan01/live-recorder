import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrations/index.js';

function oldDatabase() {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  for (const migration of MIGRATIONS.filter(m => m.version < 50)) {
    if (migration.up) migration.up(db); else if (migration.sql) db.exec(migration.sql);
    db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(migration.version);
  }
  return db;
}
describe('Xiaohongshu database upgrade', () => {
  it('retains old columns, custom indexes and FK children while extending platform constraint', () => {
    const db = oldDatabase();
    try {
      db.exec(`ALTER TABLE rooms ADD COLUMN extension TEXT;
        INSERT INTO rooms(id,platform,url,display_name,extension) VALUES ('b','bilibili','https://live.bilibili.com/1','B站','preserved');
        INSERT INTO rooms(id,platform,url,display_name) VALUES ('d','douyin','https://live.douyin.com/1','抖音');
        CREATE INDEX idx_custom_room_name ON rooms(display_name);
        CREATE TABLE custom_child(room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE);
        INSERT INTO custom_child VALUES ('b');`);
      expect(runMigrations(db)).toBe(6);
      expect(db.prepare('SELECT extension FROM rooms WHERE id=?').get('b')).toEqual({ extension: 'preserved' });
      expect(db.prepare('SELECT * FROM custom_child').all()).toEqual([{ room_id: 'b' }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_custom_room_name'").get()).toBeTruthy();
      db.exec("INSERT INTO rooms(id,platform,url) VALUES ('x','xiaohongshu','https://www.xiaohongshu.com/livestream/1')");
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(runMigrations(db)).toBe(0);
      expect(() => db.exec("INSERT INTO rooms(id,platform,url) VALUES ('bad','unknown','https://example.com')")).toThrow();
    } finally { db.close(); }
  });
  it('upgrades a v49 database to v55, keeps profile request params, and stays idempotent', () => {
    const db = oldDatabase();
    try {
      expect(runMigrations(db)).toBe(6);
      expect(db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 55 });
      const columns = (db.prepare('PRAGMA table_info(xiaohongshu_sources)').all() as Array<{ name: string }>).map(c => c.name);
      expect(columns).toEqual(expect.arrayContaining(['profile_url', 'room_url', 'profile_request_url']));
      db.prepare('INSERT INTO xiaohongshu_sources(profile_url, room_url, profile_request_url) VALUES (?,?,?)')
        .run('https://www.xiaohongshu.com/user/profile/abc', 'https://www.xiaohongshu.com/livestream/1', 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?x=1');
      expect(db.prepare('SELECT room_url, profile_request_url FROM xiaohongshu_sources WHERE profile_url=?')
        .get('https://www.xiaohongshu.com/user/profile/abc')).toEqual({
          room_url: 'https://www.xiaohongshu.com/livestream/1',
          profile_request_url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?x=1',
        });
      expect(runMigrations(db)).toBe(0);
      expect(runMigrations(db)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM xiaohongshu_sources').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
  it('converts saved profiles on v51 without changing room IDs or history associations', () => {
    const db = oldDatabase();
    try {
      for (const migration of MIGRATIONS.filter(m => m.version === 50 || m.version === 51)) {
        if (migration.up) migration.up(db);
        db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(migration.version);
      }
      const profile = 'https://www.xiaohongshu.com/user/profile/abcdef';
      const live = 'https://www.xiaohongshu.com/livestream/123?xsec_token=keep';
      db.prepare("INSERT INTO rooms(id,platform,url,display_name) VALUES ('x','xiaohongshu',?,'主播')").run(profile);
      db.exec("CREATE TABLE history_child(room_id TEXT REFERENCES rooms(id)); INSERT INTO history_child VALUES ('x')");
      db.prepare('INSERT INTO xiaohongshu_sources(profile_url,room_url) VALUES (?,?)').run(profile, live);
      expect(runMigrations(db)).toBe(4);
      expect(db.prepare('SELECT id,url,display_name FROM rooms').get()).toEqual({ id: 'x', url: live, display_name: '主播' });
      expect(db.prepare('SELECT * FROM history_child').get()).toEqual({ room_id: 'x' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
  it('rolls back a failed rebuild and restores foreign key enforcement', () => {
    const db = oldDatabase();
    try {
      db.pragma('foreign_keys = OFF');
      db.exec("CREATE TABLE custom_child(room_id TEXT REFERENCES rooms(id)); INSERT INTO custom_child VALUES ('missing')");
      db.pragma('foreign_keys = ON');
      expect(() => runMigrations(db)).toThrow('Foreign key validation failed');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare('SELECT version FROM schema_version WHERE version=50').get()).toBeUndefined();
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='rooms'").get()).not.toEqual(expect.objectContaining({ sql: expect.stringContaining('xiaohongshu') }));
    } finally { db.close(); }
  });
});
