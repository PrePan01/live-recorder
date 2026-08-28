import { create } from 'zustand';
import { fetchRecordings, openRecordingDirectory, renameRecording, deleteRecording } from '../api/recordings';
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
  renameRecording: (id: string, streamTitle: string) => Promise<void>;
  removeRecording: (id: string) => Promise<void>;
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
  async renameRecording(id, streamTitle) {
    const rec = await renameRecording(id, streamTitle);
    get().upsertRecording(rec);
  },
  async removeRecording(id) {
    await deleteRecording(id);
    set((s) => ({ items: s.items.filter((r) => r.id !== id), total: Math.max(s.total - 1, 0) }));
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
