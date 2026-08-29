export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticStatus = 'open' | 'processing' | 'resolved' | 'expired';

export interface Diagnostic {
  id: string;
  roomId: string | null;
  recordingId: string | null;
  code: string;
  severity: DiagnosticSeverity;
  status: DiagnosticStatus;
  suggestion: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
  resolvedAt: string | null;
}

export interface DiagnosticAction {
  id: string;
  diagnosticId: string;
  action: string;
  idempotencyKey: string;
  performedAt: string;
  result: 'ok' | 'failed';
  detail: string | null;
}

export interface PagedDiagnostics {
  items: Diagnostic[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DiagnosticDetail {
  diagnostic: Diagnostic;
  actions: DiagnosticAction[];
}