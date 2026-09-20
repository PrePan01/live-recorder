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
  };
}

export class AlertRepository {
  constructor(private db: DB) {}

  create(input: { level: AlertLevel; source: string; message: string; occurredAt: string; roomId?: string | null; errorCode?: string | null }): Alert {
    const id = newId('alr');
    this.db
      .prepare('INSERT INTO alerts (id, level, source, message, occurred_at, resolved, room_id, error_code) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, input.level, input.source, input.message, input.occurredAt, input.roomId ?? null, input.errorCode ?? null);
    return this.get(id)!;
  }

  /**
   * 同一未读故障持续存在时只保留一条告警，并刷新发生时间。轮询失败不应
   * 以房间数 × 检测轮次无限堆叠；一旦标记已读，后续再次失败会新建告警。
   */
  createOrRefresh(input: { level: AlertLevel; source: string; message: string; occurredAt: string; roomId?: string | null; errorCode?: string | null }): Alert {
    const existing = this.db
      .prepare(`SELECT * FROM alerts
        WHERE resolved = 0 AND source = ? AND message = ?
          AND room_id IS ? AND error_code IS ?
        ORDER BY occurred_at DESC LIMIT 1`)
      .get(input.source, input.message, input.roomId ?? null, input.errorCode ?? null) as AlertRow | undefined;
    if (!existing) return this.create(input);
    this.db.prepare('UPDATE alerts SET occurred_at = ? WHERE id = ?').run(input.occurredAt, existing.id);
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

  markAllResolved(): number {
    return this.db.prepare('UPDATE alerts SET resolved = 1 WHERE resolved = 0').run().changes;
  }

  clearAll(): number {
    return this.db.prepare('DELETE FROM alerts').run().changes;
  }
}
