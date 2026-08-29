import { http } from './client';
import type { ExportJob } from '../types/export';

export async function createExport(recordingIds: string[], baseDir: string): Promise<ExportJob> {
  const { data } = await http.post<{ export: ExportJob }>('/exports', { recordingIds, baseDir });
  return data.export;
}

export async function fetchExports(): Promise<ExportJob[]> {
  const { data } = await http.get<{ exports: ExportJob[] }>('/exports');
  return data.exports;
}

export async function fetchExport(id: string): Promise<ExportJob> {
  const { data } = await http.get<{ export: ExportJob }>(`/exports/${id}`);
  return data.export;
}

export async function cancelExport(id: string): Promise<ExportJob> {
  const { data } = await http.post<{ export: ExportJob }>(`/exports/${id}/cancel`);
  return data.export;
}

export function openExportPath(outputPath: string): void {
  window.open(outputPath);
}