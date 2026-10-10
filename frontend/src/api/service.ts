import { http } from './client';
import type { ServiceStatus } from '../types/service';

export type SelfCheckStatus = 'ok' | 'fail' | 'warn' | 'pending';

export interface SelfCheckItem {
  key: string;
  label: string;
  status: SelfCheckStatus;
  detail?: string;
  fixHint?: string;
}

export async function fetchServiceStatus(): Promise<ServiceStatus> {
  const { data } = await http.get<{ serviceStatus: ServiceStatus }>('/service/status');
  return data.serviceStatus;
}

export async function fetchRecordingDownloadSpeed(): Promise<number> {
  const { data } = await http.get<{ bytesPerSecond: number }>('/service/download-speed');
  return data.bytesPerSecond;
}

export async function fetchSelfCheck(): Promise<SelfCheckItem[]> {
  const { data } = await http.get<{ items: SelfCheckItem[] }>('/service/self-check');
  return data.items;
}
