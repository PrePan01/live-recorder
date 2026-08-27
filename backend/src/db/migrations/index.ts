import type { DB } from '../connection.js';

export interface Migration {
  version: number;
  sql: string;
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
];

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
      db.exec(m.sql);
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
