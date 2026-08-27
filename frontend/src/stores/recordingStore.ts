import { create } from 'zustand';
import { fetchRecordings, openRecordingDirectory } from '../api/recordings';
import type { Recording, RecordingQuery } from '../types/recording';

interface RecordingState {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  query: RecordingQuery;
  fetchHistory: (q?: RecordingQuery) => Promise<void>;
  openDirectory: (id: string) => Promise<void>;
  upsertRecording: (rec: Recording) => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  query: {},
  async fetchHistory(q) {
    const query = { ...get().query, ...q };
    set({ loading: true, query });
    try {
      const res = await fetchRecordings(query);
      set({ items: res.items, total: res.total, page: res.page, pageSize: res.pageSize, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  async openDirectory(id) {
    await openRecordingDirectory(id);
  },
  upsertRecording(rec) {
    set((s) => {
      const idx = s.items.findIndex((r) => r.id === rec.id);
      if (idx === -1) return {};
      const next = [...s.items];
      next[idx] = rec;
      return { items: next };
    });
  },
}));
