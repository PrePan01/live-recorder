import type { DB } from '../connection.js';
import type { Diagnostic, DiagnosticAction, DiagnosticSeverity, DiagnosticStatus } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface DiagnosticRow {
  id: string;
  room_id: string | null;
  recording_id: string | null;
  code: string;
  severity: string;
  status: string;
  suggestion: string;
  details: string | null;
  occurred_at: string;
  resolved_at: string | null;
}

interface DiagnosticActionRow {
  id: string;
  diagnostic_id: string;
  action: string;
  idempotency_key: string;
  result: string;
  detail: string | null;
  performed_at: string;
}

function rowToDiagnostic(row: DiagnosticRow): Diagnostic {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      details = null;
    }
  }
  return {
    id: row.id,
    roomId: row.room_id,
    recordingId: row.recording_id,
    code: row.code,
    severity: row.severity as DiagnosticSeverity,
    status: row.status as DiagnosticStatus,
    suggestion: row.suggestion,
    details,
    occurredAt: row.occurred_at,
    resolvedAt: row.resolved_at,
  };
}

export interface DiagnosticListQuery {
  status?: DiagnosticStatus | undefined;
  severity?: DiagnosticSeverity | undefined;
  roomId?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export class DiagnosticRepository {
  constructor(private db: DB) {}

  create(input: {
    roomId?: string | null;
    recordingId?: string | null;
    code: string;
    severity: DiagnosticSeverity;
    suggestion?: string;
    details?: Record<string, unknown> | null;
  }): Diagnostic {
    const id = newId('diag');
    const occurredAt = nowIso();
    // 同一 recordingId+code 只允许一个活跃项（open/processing）；若已存在则复用并刷新。
    if (input.recordingId) {
      const active = this.db
        .prepare(`SELECT id FROM diagnostics WHERE recording_id = ? AND code = ? AND status IN ('open', 'processing') LIMIT 1`)
        .get(input.recordingId, input.code) as { id: string } | undefined;
      if (active) return this.get(active.id)!;
    }
    this.db
      .prepare(
        `INSERT INTO diagnostics (id, room_id, recording_id, code, severity, status, suggestion, details, occurred_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`,
      )
      .run(id, input.roomId ?? null, input.recordingId ?? null, input.code, input.severity, input.suggestion ?? '', input.details ? JSON.stringify(input.details) : null, occurredAt);
    return this.get(id)!;
  }

  get(id: string): Diagnostic | null {
    const row = this.db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(id) as DiagnosticRow | undefined;
    return row ? rowToDiagnostic(row) : null;
  }

  list(query: DiagnosticListQuery = {}): { items: Diagnostic[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.severity) {
      where.push('severity = ?');
      params.push(query.severity);
    }
    if (query.roomId) {
      where.push('room_id = ?');
      params.push(query.roomId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM diagnostics ${whereSql}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM diagnostics ${whereSql} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as DiagnosticRow[];
    return { items: rows.map(rowToDiagnostic), total, page, pageSize };
  }

  setStatus(id: string, status: DiagnosticStatus, resolvedAt: string | null = null): Diagnostic {
    this.db
      .prepare(`UPDATE diagnostics SET status = ?, resolved_at = ?, occurred_at = occurred_at WHERE id = ?`)
      .run(status, resolvedAt, id);
    return this.get(id)!;
  }

  /** 幂等记录动作：同 idempotencyKey 返回既有记录，不重复执行副作用。 */
  recordAction(input: { diagnosticId: string; action: string; idempotencyKey: string; result: 'ok' | 'failed'; detail?: string | null }): DiagnosticAction {
    const existing = this.db.prepare('SELECT * FROM diagnostic_actions WHERE idempotency_key = ?').get(input.idempotencyKey) as DiagnosticActionRow | undefined;
    if (existing) return rowToAction(existing);
    const id = newId('act');
    const performedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO diagnostic_actions (id, diagnostic_id, action, idempotency_key, result, detail, performed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.diagnosticId, input.action, input.idempotencyKey, input.result, input.detail ?? null, performedAt);
    return {
      id,
      diagnosticId: input.diagnosticId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      result: input.result,
      detail: input.detail ?? null,
      performedAt,
    };
  }

  actionsFor(diagnosticId: string): DiagnosticAction[] {
    const rows = this.db
      .prepare('SELECT * FROM diagnostic_actions WHERE diagnostic_id = ? ORDER BY performed_at ASC')
      .all(diagnosticId) as DiagnosticActionRow[];
    return rows.map(rowToAction);
  }

  /** 过期开放项（如超过 30 天未处理）标记 expired。 */
  expireOpen(olderThanIso: string): number {
    return this.db
      .prepare(`UPDATE diagnostics SET status = 'expired' WHERE status IN ('open', 'processing') AND occurred_at < ?`)
      .run(olderThanIso).changes;
  }
}

function rowToAction(row: DiagnosticActionRow): DiagnosticAction {
  return {
    id: row.id,
    diagnosticId: row.diagnostic_id,
    action: row.action,
    idempotencyKey: row.idempotency_key,
    result: row.result as 'ok' | 'failed',
    detail: row.detail,
    performedAt: row.performed_at,
  };
}