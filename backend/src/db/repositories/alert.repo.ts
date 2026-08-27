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
}

function rowToAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    level: row.level as AlertLevel,
    source: row.source,
    message: row.message,
    occurredAt: row.occurred_at,
    resolved: row.resolved === 1,
  };
}

export class AlertRepository {
  constructor(private db: DB) {}

  create(input: { level: AlertLevel; source: string; message: string; occurredAt: string }): Alert {
    const id = newId('alr');
    this.db
      .prepare('INSERT INTO alerts (id, level, source, message, occurred_at, resolved) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, input.level, input.source, input.message, input.occurredAt);
    return this.get(id)!;
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
}
