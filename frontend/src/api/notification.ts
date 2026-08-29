import { http } from './client';
import type { LivePrediction, NotificationPreference } from '../types/notification';

export async function fetchNotifications(): Promise<NotificationPreference> {
  const { data } = await http.get<{ notifications: NotificationPreference }>('/settings/notifications');
  return data.notifications;
}

export async function updateNotifications(
  input: Partial<NotificationPreference>,
): Promise<NotificationPreference> {
  const { data } = await http.put<{ notifications: NotificationPreference }>('/settings/notifications', input);
  return data.notifications;
}

export async function testNotification(): Promise<{ ok: boolean; desktop: boolean; email: string }> {
  const { data } = await http.post<{ ok: boolean; desktop: boolean; email: string }>('/notifications/test');
  return data;
}

export async function fetchLivePrediction(roomId: string): Promise<LivePrediction> {
  const { data } = await http.get<LivePrediction>(`/rooms/${roomId}/live-prediction`);
  return data;
}