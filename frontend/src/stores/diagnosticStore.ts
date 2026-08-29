import { create } from 'zustand';
import * as diagApi from '../api/diagnostics';
import type { Diagnostic, DiagnosticDetail } from '../types/diagnostic';

interface DiagnosticState {
  items: Diagnostic[];
  total: number;
  loading: boolean;
  detail: DiagnosticDetail | null;
  detailLoading: boolean;
  actingId: string | null;
  actingAction: string | null;
  fetch: (q?: diagApi.DiagnosticQuery) => Promise<void>;
  loadDetail: (id: string) => Promise<void>;
  runAction: (id: string, action: string) => Promise<DiagnosticDetail>;
  upsert: (d: Diagnostic) => void;
}

export const useDiagnosticStore = create<DiagnosticState>((set) => ({
  items: [],
  total: 0,
  loading: false,
  detail: null,
  detailLoading: false,
  actingId: null,
  actingAction: null,
  async fetch(q) {
    set({ loading: true });
    try {
      const res = await diagApi.fetchDiagnostics(q);
      set({ items: res.items, total: res.total, loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchDiagnostics failed');
    }
  },
  async loadDetail(id) {
    set({ detailLoading: true });
    try {
      set({ detail: await diagApi.fetchDiagnosticDetail(id), detailLoading: false });
    } catch {
      set({ detailLoading: false });
      throw new Error('loadDetail failed');
    }
  },
  async runAction(id, action) {
    set({ actingId: id, actingAction: action });
    try {
      const detail = await diagApi.runDiagnosticAction(id, action, `${Date.now()}-${id}-${action}`);
      set((s) => {
        const next = s.detail && s.detail.diagnostic.id === id ? detail : s.detail;
        return {
          detail: next,
          items: s.items.map((d) => (d.id === id ? detail.diagnostic : d)),
        };
      });
      return detail;
    } finally {
      set({ actingId: null, actingAction: null });
    }
  },
  upsert(d) {
    set((s) => {
      const idx = s.items.findIndex((x) => x.id === d.id);
      if (idx === -1) return { items: [d, ...s.items] };
      const next = [...s.items];
      next[idx] = d;
      return { items: next };
    });
  },
}));