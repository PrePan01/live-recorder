import { create } from 'zustand';
import { fetchSettings, updateSettings } from '../api/settings';
import type { Settings, SettingsInput } from '../types/settings';

interface SettingsState {
  settings: Settings | null;
  loading: boolean;
  load: () => Promise<void>;
  save: (input: SettingsInput) => Promise<void>;
  setSettings: (s: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  async load() {
    set({ loading: true });
    try {
      set({ settings: await fetchSettings(), loading: false });
    } catch {
      set({ loading: false });
    }
  },
  async save(input) {
    set({ settings: await updateSettings(input) });
  },
  setSettings: (s) => set({ settings: s }),
}));
