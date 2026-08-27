import { create } from 'zustand';
import { fetchServiceStatus } from '../api/service';
import type { ServiceStatus } from '../types/service';

interface ServiceState {
  status: ServiceStatus | null;
  sseConnected: boolean;
  loading: boolean;
  fetchStatus: () => Promise<void>;
  setSseConnected: (v: boolean) => void;
  patchStatus: (p: Partial<ServiceStatus>) => void;
}

export const useServiceStore = create<ServiceState>((set) => ({
  status: null,
  sseConnected: false,
  loading: false,
  async fetchStatus() {
    set({ loading: true });
    try {
      set({ status: await fetchServiceStatus(), loading: false });
    } catch {
      set({
        loading: false,
        status: {
          state: 'running',
          version: null,
          disk: { freeBytes: 0, totalBytes: 0 },
          activeRecordings: 0,
          setupCompleted: false,
        },
      });
    }
  },
  setSseConnected: (v) => set({ sseConnected: v }),
  patchStatus: (p) => set((s) => ({ status: s.status ? { ...s.status, ...p } : s.status })),
}));

export const selectSetupCompleted = (s: ServiceState) => s.status?.setupCompleted ?? false;
