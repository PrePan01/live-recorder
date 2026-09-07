import { create } from 'zustand';
import { EndpointResolver } from '../api/endpoint';
import { fetchServiceStatus } from '../api/service';
import type { ServiceStatus } from '../types/service';

interface ServiceState {
  status: ServiceStatus | null;
  sseConnected: boolean;
  loading: boolean;
  error: string | null;
  fetchStatus: () => Promise<void>;
  setSseConnected: (v: boolean) => void;
  patchStatus: (p: Partial<ServiceStatus>) => void;
}

export const useServiceStore = create<ServiceState>((set, get) => ({
  status: null,
  sseConnected: false,
  loading: false,
  error: null,
  async fetchStatus() {
    if (get().loading) return;
    const endpoint = EndpointResolver.base;
    set({ loading: true, error: null });
    try {
      const status = await fetchServiceStatus();
      if (endpoint !== EndpointResolver.base) return;
      set({ status, loading: false, error: null });
    } catch {
      if (endpoint !== EndpointResolver.base) return;
      set({
        loading: false,
        // 连接失败不能证明尚未初始化；保留最后一次可信状态。
        error: '无法连接到本地服务，请稍后重试。',
      });
    }
  },
  setSseConnected: (v) => set({ sseConnected: v }),
  patchStatus: (p) => set((s) => ({ status: s.status ? { ...s.status, ...p } : s.status })),
}));

export const selectSetupCompleted = (s: ServiceState) => s.status?.setupCompleted ?? false;
