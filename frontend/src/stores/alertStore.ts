import { create } from 'zustand';
import { fetchAlerts, markAlertRead, markAllAlertsRead } from '../api/alerts';
import { checkRoomNow } from '../api/rooms';
import type { Alert } from '../types/alert';

interface AlertState {
  alerts: Alert[];
  loading: boolean;
  retryingId: string | null;
  fetchAlerts: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  retryFailure: (alert: Alert) => Promise<void>;
  upsertAlert: (alert: Alert) => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  alerts: [],
  loading: false,
  retryingId: null,
  async fetchAlerts() {
    set({ loading: true });
    try {
      set({ alerts: await fetchAlerts(), loading: false });
    } catch {
      set({ loading: false });
    }
  },
  async markRead(id) {
    await markAlertRead(id);
    set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, resolved: true } : a)) }));
  },
  async markAllRead() {
    await markAllAlertsRead();
    set((s) => ({ alerts: s.alerts.map((a) => ({ ...a, resolved: true })) }));
  },
  async retryFailure(alert) {
    if (!alert.roomId) throw new Error('该告警无可重试房间');
    set({ retryingId: alert.id });
    try {
      await checkRoomNow(alert.roomId);
    } finally {
      set({ retryingId: null });
    }
  },
  upsertAlert(alert) {
    set((s) => {
      const idx = s.alerts.findIndex((a) => a.id === alert.id);
      if (idx === -1) return { alerts: [alert, ...s.alerts] };
      const next = [...s.alerts];
      next[idx] = alert;
      return { alerts: next };
    });
  },
}));

export const selectUnreadCount = (s: AlertState) => s.alerts.filter((a) => !a.resolved).length;
