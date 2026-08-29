import { create } from 'zustand';
import * as notifyApi from '../api/notification';
import type { NotificationPreference } from '../types/notification';

interface NotificationState {
  preferences: NotificationPreference | null;
  loading: boolean;
  load: () => Promise<void>;
  save: (input: Partial<NotificationPreference>) => Promise<void>;
  setPreferences: (p: NotificationPreference) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  preferences: null,
  loading: false,
  async load() {
    set({ loading: true });
    try {
      set({ preferences: await notifyApi.fetchNotifications(), loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchNotifications failed');
    }
  },
  async save(input) {
    set({ preferences: await notifyApi.updateNotifications(input) });
  },
  setPreferences(p) {
    set({ preferences: p });
  },
}));