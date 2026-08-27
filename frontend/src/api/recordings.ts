import { http } from './client';
import type { PagedRecordings, RecordingQuery } from '../types/recording';

export async function fetchRecordings(query: RecordingQuery): Promise<PagedRecordings> {
  const { data } = await http.get<PagedRecordings>('/recordings', { params: query });
  return data;
}

export async function openRecordingDirectory(id: string): Promise<void> {
  await http.post(`/recordings/${id}/open`);
}
