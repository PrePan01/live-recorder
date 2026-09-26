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
   * 同一未读故障持续存在时只保留一条告警，并刷新发生时间。轮询失败不应
   * 以房间数 × 检测轮次无限堆叠；一旦标记已读，后续再次失败会新建告警。
   */
  createOrRefresh(input: { level: AlertLevel; source: string; message: string; occurredAt: string; roomId?: string | null; errorCode?: string | null; retryable?: boolean | null }): Alert {
    const existing = this.db
      .prepare(`SELECT * FROM alerts
        WHERE resolved = 0 AND source = ? AND message = ?
          AND room_id IS ? AND error_code IS ?
        ORDER BY occurred_at DESC LIMIT 1`)
      .get(input.source, input.message, input.roomId ?? null, input.errorCode ?? null) as AlertRow | undefined;
    if (!existing) return this.create(input);
    this.db.prepare('UPDATE alerts SET occurred_at = ?, retryable = COALESCE(?, retryable) WHERE id = ?').run(input.occurredAt, input.retryable == null ? null : input.retryable ? 1 : 0, existing.id);
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
