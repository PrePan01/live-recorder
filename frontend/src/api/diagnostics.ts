import { http } from './client';
import type { ErrorDiagnostic } from '../utils/errorDiagnostics';
import type { DiagnosticDetail, DiagnosticStatus, PagedDiagnostics } from '../types/diagnostic';

export interface DiagnosticQuery {
  status?: DiagnosticStatus;
  severity?: string;
  roomId?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchDiagnostics(q: DiagnosticQuery = {}): Promise<PagedDiagnostics> {
  const { data } = await http.get<PagedDiagnostics>('/diagnostics', { params: q });
  return data;
}

export async function fetchDiagnosticDetail(id: string): Promise<DiagnosticDetail> {
  const { data } = await http.get<DiagnosticDetail>(`/diagnostics/${id}`);
  return data;
}

export async function runDiagnosticAction(id: string, action: string, idempotencyKey: string): Promise<DiagnosticDetail> {
  const { data } = await http.post<DiagnosticDetail>(`/diagnostics/${id}/actions/${action}`, { idempotencyKey });
  return data;
}

export interface DiagnosticExportFileResult {
  ok: boolean;
  saved: boolean;
  path: string | null;
  reason: 'cancelled' | 'no-dialog' | null;
}

export async function exportDiagnosticsToFile(frontendDiagnostics: readonly ErrorDiagnostic[], includeRooms: boolean): Promise<DiagnosticExportFileResult> {
  const { data } = await http.post<DiagnosticExportFileResult>('/diagnostics/export-file', { frontendDiagnostics, includeRooms }, { timeout: 0 });
  return data;
}

export async function downloadDiagnostics(frontendDiagnostics: readonly ErrorDiagnostic[], includeRooms: boolean): Promise<void> {
  const response = await http.post<Blob>('/diagnostics/export-download', { frontendDiagnostics, includeRooms }, { responseType: 'blob', timeout: 0 });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `live-recorder-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}
