import { http } from './client';

export type UploadStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

export interface UploadJob {
  id: string;
  recordingId: string;
  status: UploadStatus;
  progress: number;
  remotePath: string | null;
  error: string | null;
  retryCount: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenListConfig {
  enabled: boolean;
  serverUrl: string;
  directoryTemplate: string;
  username: string;
  hasToken: boolean;
}

export async function fetchOpenListConfig(): Promise<OpenListConfig> {
  const { data } = await http.get<OpenListConfig>('/settings/openlist');
  return data;
}

export async function updateOpenListConfig(
  input: Partial<Omit<OpenListConfig, 'hasToken'>> & { token?: string },
): Promise<OpenListConfig> {
  const { data } = await http.put<OpenListConfig>('/settings/openlist', input);
  return data;
}

export async function testOpenList(): Promise<{ ok: boolean }> {
  const { data } = await http.post<{ ok: boolean }>('/settings/openlist/test');
  return data;
}

export async function fetchUploads(limit = 20): Promise<UploadJob[]> {
  const { data } = await http.get<{ uploads: UploadJob[] }>('/uploads', { params: { limit } });
  return data.uploads;
}

export async function retryUpload(id: string): Promise<UploadJob> {
  const { data } = await http.post<{ upload: UploadJob }>(`/uploads/${id}/retry`);
  return data.upload;
}

export async function cancelUpload(id: string): Promise<UploadJob> {
  const { data } = await http.post<{ upload: UploadJob }>(`/uploads/${id}/cancel`);
  return data.upload;
}

export async function uploadRecording(recordingId: string): Promise<UploadJob> {
  const { data } = await http.post<{ upload: UploadJob }>(`/recordings/${recordingId}/upload`);
  return data.upload;
}