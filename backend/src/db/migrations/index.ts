import type { DB } from '../connection.js';

export interface Migration {
  version: number;
  /** 简单 SQL 迁移（原子执行）。 */
  sql?: string;
  /** 需要幂等/条件判断的迁移（如 ALTER 加列前 PRAGMA 判存在）。与 sql 二选一。 */
  up?: (db: DB) => void;
}

/** 迁移脚本注册表：按版本号顺序执行，幂等（schema_version 记录已应用版本）。 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('bilibili', 'douyin')),
  url TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  monitor_state TEXT NOT NULL DEFAULT 'idle',
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, url)
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  platform TEXT NOT NULL,
  stream_session_id TEXT,
  stream_title TEXT DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  file_path TEXT,
  file_size_bytes INTEGER DEFAULT 0,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  quality TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recordings_room_id ON recordings(room_id);
CREATE INDEX idx_recordings_stream_session ON recordings(room_id, stream_session_id);
CREATE INDEX idx_recordings_state ON recordings(state);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_alerts_resolved ON alerts(resolved);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE rooms ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    // #39：v2 在部分存量库（schema_version 已记录 2 但列缺失）被跳过，
    // 追加 v3 幂等补列，确保任意历史 DB 都具备 favorited 列。
    version: 3,
    up: (db) => {
      const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('rooms') WHERE name = 'favorited'`).get();
      if (!has) {
        db.exec(`ALTER TABLE rooms ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0;`);
      }
    },
  },
  {
    // #50：录制完整性校验列（ffprobe 结果），幂等加列。
    version: 4,
    up: (db) => {
      const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('recordings') WHERE name = 'integrity'`).get();
      if (!has) {
        db.exec(`ALTER TABLE recordings ADD COLUMN integrity TEXT;`);
      }
    },
  },
  {
    // #54：告警中心结构化字段——roomId/errorCode，供失败一键重试定位房间。幂等加列。
    version: 5,
    up: (db) => {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('alerts')`).all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('room_id')) db.exec(`ALTER TABLE alerts ADD COLUMN room_id TEXT;`);
      if (!names.has('error_code')) db.exec(`ALTER TABLE alerts ADD COLUMN error_code TEXT;`);
    },
  },
  {
    // #75：房间级自动录制开关（覆盖全局 settings.autoRecord），幂等加列。
    version: 6,
    up: (db) => {
      const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('rooms') WHERE name = 'auto_record'`).get();
      if (!has) {
        db.exec(`ALTER TABLE rooms ADD COLUMN auto_record INTEGER;`);
      }
    },
  },
  {
    // #78：最近一次检测的直播状态（live/offline/restricted），幂等加列。
    version: 7,
    up: (db) => {
      const has = db.prepare(`SELECT 1 AS x FROM pragma_table_info('rooms') WHERE name = 'last_live_status'`).get();
      if (!has) {
        db.exec(`ALTER TABLE rooms ADD COLUMN last_live_status TEXT;`);
      }
    },
  },
  {
    // #92：删除直播间不再级联删录制历史——去掉 recordings.room_id 对 rooms 的外键
    // （SQLite 无法 DROP CONSTRAINT，需重建表），并新增 room_name 快照列
    // （创建录播时写入房间显示名，供删房后历史页展示房间名）。
    // 幂等保护：若列已存在且外键已移除则跳过。
    version: 8,
    up: (db) => {
      const hasRoomName = Boolean(db.prepare(`SELECT 1 AS x FROM pragma_table_info('recordings') WHERE name = 'room_name'`).get());
      const fkCount = (db.prepare(`SELECT COUNT(*) AS c FROM pragma_foreign_key_list('recordings')`).get() as { c: number }).c;
      if (hasRoomName && fkCount === 0) return;
      db.exec(`
        CREATE TABLE recordings_new (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          stream_session_id TEXT,
          stream_title TEXT DEFAULT '',
          state TEXT NOT NULL DEFAULT 'pending',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          file_path TEXT,
          file_size_bytes INTEGER DEFAULT 0,
          failure_reason TEXT,
          retry_count INTEGER DEFAULT 0,
          quality TEXT,
          integrity TEXT,
          room_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO recordings_new (id, room_id, platform, stream_session_id, stream_title, state, started_at, ended_at, file_path, file_size_bytes, failure_reason, retry_count, quality, integrity, room_name, created_at)
          SELECT id, room_id, platform, stream_session_id, stream_title, state, started_at, ended_at, file_path, file_size_bytes, failure_reason, retry_count, quality, integrity, '', created_at FROM recordings;
        DROP TABLE recordings;
        ALTER TABLE recordings_new RENAME TO recordings;
        CREATE INDEX idx_recordings_room_id ON recordings(room_id);
        CREATE INDEX idx_recordings_stream_session ON recordings(room_id, stream_session_id);
        CREATE INDEX idx_recordings_state ON recordings(state);
      `);
    },
  },
];

/** 幂等保护：执行迁移前检查其依赖的列/表已存在，避免历史 DB 重复执行报错。 */
export function runMigrations(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map((r: unknown) => (r as { version: number }).version),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      if (m.up) {
        m.up(db);
      } else if (m.sql) {
        db.exec(m.sql);
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
    count += 1;
  }
  return count;
}

export function currentSchemaVersion(db: DB): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}
