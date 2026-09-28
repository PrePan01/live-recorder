import type { DB } from '../connection.js';
import type { Alert, AlertLevel } from '../../types/index.js';
import { newId } from '../../utils/id.js';

interface AlertRow {
  id: string;
  level: string;
  source: string;
  message: string;
  occurred_at: string;
  resolved: number;
  room_id: string | null;
  error_code: string | null;
  retryable: number | null;
  read: number;
}

function rowToAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    level: row.level as AlertLevel,
    source: row.source,
    message: row.message,
    occurredAt: row.occurred_at,
    resolved: row.resolved === 1,
    roomId: row.room_id ?? null,
    errorCode: row.error_code ?? null,
    retryable: row.retryable == null ? null : row.retryable === 1,
    read: row.read === 1,
  };
}

export class AlertRepository {
  constructor(private db: DB) {}

  create(input: { level: AlertLevel; source: string; message: string; occurredAt: string; roomId?: string | null; errorCode?: string | null; retryable?: boolean | null }): Alert {
    const id = newId('alr');
    this.db
      .prepare('INSERT INTO alerts (id, level, source, message, occurred_at, resolved, room_id, error_code, retryable) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, input.level, input.source, input.message, input.occurredAt, input.roomId ?? null, input.errorCode ?? null, input.retryable == null ? null : input.retryable ? 1 : 0);
    return this.get(id)!;
  }

  /**
   * 告警身份 = 来源 + 房间 + 错误码（码为空时退化用文案，避免内部错误互相覆盖）；
   * 文案/级别/发生时间/可重试都是可刷新载荷。生命周期一个闭环：
   * 已读但错误持续 → 只刷载荷与时间（不复活不重闹）；已恢复 → 复活为未读（复发再报）；
   * 未读持续 → 刷新（原有语义）。恢复由 resolveForRoom 单独标记。
   */
  createOrRefresh(input: { level: AlertLevel; source: string; message: string; occurredAt: string; roomId?: string | null; errorCode?: string | null; retryable?: boolean | null }): Alert {
    const roomId = input.roomId ?? null;
    const errorCode = input.errorCode ?? null;
    const existing = (
      errorCode != null
        ? this.db
            .prepare('SELECT * FROM alerts WHERE source = ? AND room_id IS ? AND error_code IS ? ORDER BY occurred_at DESC LIMIT 1')
            .get(input.source, roomId, errorCode)
        : this.db
            .prepare('SELECT * FROM alerts WHERE source = ? AND room_id IS ? AND error_code IS NULL AND message = ? ORDER BY occurred_at DESC LIMIT 1')
            .get(input.source, roomId, input.message)
    ) as AlertRow | undefined;
    if (!existing) return this.create(input);
    const wasResolved = existing.resolved === 1;
    this.db
      .prepare('UPDATE alerts SET message = ?, level = ?, occurred_at = ?, retryable = COALESCE(?, retryable), resolved = CASE WHEN ? = 1 THEN 0 ELSE resolved END, read = CASE WHEN ? = 1 THEN 0 ELSE read END WHERE id = ?')
      .run(
        input.message,
        input.level,
        input.occurredAt,
        input.retryable == null ? null : input.retryable ? 1 : 0,
        wasResolved ? 1 : 0,
        wasResolved ? 1 : 0,
        existing.id,
      );
    return this.get(existing.id)!;
  }

  get(id: string): Alert | null {
    const row = this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
    return row ? rowToAlert(row) : null;
  }

  list(opts: { unresolvedOnly?: boolean | undefined; limit?: number | undefined } = {}): Alert[] {
    const where = opts.unresolvedOnly ? 'WHERE resolved = 0' : '';
    const limit = opts.limit ?? 100;
    const rows = this.db.prepare(`SELECT * FROM alerts ${where} ORDER BY occurred_at DESC LIMIT ?`).all(limit) as AlertRow[];
    return rows.map(rowToAlert);
  }

  /** 标记已读（与恢复分离）：已读但错误持续时，后续同错只刷新不重闹。 */
  markRead(id: string): Alert | null {
    this.db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(id);
    return this.get(id);
  }

  markAllRead(): number {
    return this.db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run().changes;
  }

  markResolved(id: string): Alert | null {
    this.db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(id);
    return this.get(id);
  }

  /**
   * 房间级告警的自动收敛：一次瞬时误判（如开播/关播窗口的平台接口误报）不该长期挂在
   * 告警列表里，检测确认恢复后应随之消解。仅作用于指定房间，平台级告警
   * （room_id 为空，如授权失效）不受影响。返回本条被消解的告警，供调用方推送更新。
   */
  resolveForRoom(roomId: string, source?: string): Alert[] {
    const where = source
      ? 'resolved = 0 AND room_id = ? AND source = ?'
      : 'resolved = 0 AND room_id = ?';
    const params = source ? [roomId, source] : [roomId];
    const rows = this.db
      .prepare(`SELECT * FROM alerts WHERE ${where}`)
      .all(...params) as AlertRow[];
    if (rows.length === 0) return [];
    this.db.prepare(`UPDATE alerts SET resolved = 1 WHERE ${where}`).run(...params);
    return rows.map((row) => rowToAlert({ ...row, resolved: 1 }));
  }

  markAllResolved(): number {
    return this.db.prepare('UPDATE alerts SET resolved = 1 WHERE resolved = 0').run().changes;
  }

  clearAll(): number {
    return this.db.prepare('DELETE FROM alerts').run().changes;
  }
}
