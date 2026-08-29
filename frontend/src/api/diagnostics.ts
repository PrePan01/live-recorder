import { http } from './client';
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