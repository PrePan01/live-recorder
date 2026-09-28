import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // WAL 标准配对：同步档降为 NORMAL（掉电安全边界仍由 WAL 保证），
    // 录制高峰写入（落盘×轮询×事件同库）的 fsync 频率大幅下降。默认 FULL 对常驻写入型进程过重。
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (error) { db.close(); throw error; }
}
