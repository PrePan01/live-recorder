import { http } from './client';
import type { PagedRecordings, Recording, RecordingQuery } from '../types/recording';

export async function fetchRecordings(query: RecordingQuery): Promise<PagedRecordings> {
  const { data } = await http.get<PagedRecordings>('/recordings', { params: query });
  return data;
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
