export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticStatus = 'open' | 'processing' | 'resolved' | 'expired';

/**
 * V5 自愈工作台诊断项。同一 `recordingId+code`（或 roomId+code）只允许一个活跃项；
 * 动作幂等执行（同 key 并发仅一次），成功后可追溯为 resolved。
 */
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