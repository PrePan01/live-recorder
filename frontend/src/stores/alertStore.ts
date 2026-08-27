import { create } from 'zustand';
import { fetchAlerts, markAlertRead, markAllAlertsRead } from '../api/alerts';
import type { Alert } from '../types/alert';

interface AlertState {
  alerts: Alert[];
  loading: boolean;
  fetchAlerts: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  upsertAlert: (alert: Alert) => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  alerts: [],
  loading: false,
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
