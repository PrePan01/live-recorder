import { http } from './client';
import type { PagedRecordings, Recording, RecordingQuery } from '../types/recording';

export async function fetchRecordings(query: RecordingQuery): Promise<PagedRecordings> {
  const { data } = await http.get<PagedRecordings>('/recordings', { params: query });
  return data;
}

export interface BatchDeleteResult {
  deleted: string[];
  failed: Array<{ id: string; reason: string }>;
}

export async function batchDeleteRecordings(ids: string[]): Promise<BatchDeleteResult> {
  const { data } = await http.post<BatchDeleteResult>('/recordings/batch-delete', { ids });
  return data;
}

export async function exportRecordingsCsv(): Promise<string> {
  const res = await http.get('/recordings/export', { responseType: 'blob' });
  return (res.data as Blob).text();
}

export async function openRecordingDirectory(id: string): Promise<void> {
  await http.post(`/recordings/${id}/open`);
}

export async function renameRecording(id: string, streamTitle: string): Promise<Recording> {
  const { data } = await http.patch<{ recording: Recording }>(`/recordings/${id}`, { streamTitle });
  return data.recording;
}

export async function deleteRecording(id: string): Promise<void> {
  await http.delete(`/recordings/${id}`);
}
