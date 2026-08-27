import { http } from './client';
import type { Alert } from '../types/alert';

export async function fetchAlerts(): Promise<Alert[]> {
  const { data } = await http.get<{ alerts: Alert[] }>('/alerts');
  return data.alerts;
}

export async function markAlertRead(id: string): Promise<void> {
  await http.patch(`/alerts/${id}`, { resolved: true });
}

export async function markAllAlertsRead(): Promise<void> {
  await http.post('/alerts/read-all');
}
