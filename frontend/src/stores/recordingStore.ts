import { create } from 'zustand';
import {
  fetchRecordings,
  openRecordingDirectory,
  renameRecording,
  deleteRecording,
  batchDeleteRecordings,
  exportRecordingsCsv,
} from '../api/recordings';
import type { Recording, RecordingQuery } from '../types/recording';

function normalizeRecording(rec: Recording): Recording {
  return { ...rec, integrity: rec.integrity ?? null };
}

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
  batchRemove: (ids: string[]) => Promise<{ deleted: string[]; failed: Array<{ id: string; reason: string }> }>;
  exportCsv: () => Promise<string>;
  upsertRecording: (rec: Recording) => void;
  /** 仅由 SSE 写入，用于避免打开历史页时把旧记录误报成刚完成。 */
  upsertRecordingFromEvent: (rec: Recording) => void;
  completionNotice: Recording | null;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  completionNotice: null,
  query: {},
  async fetchHistory(q) {
    const query = { ...get().query, ...q };
    set({ loading: true, query });
    try {
      const res = await fetchRecordings(query);
      set({ items: res.items.map(normalizeRecording), total: res.total, page: res.page, pageSize: res.pageSize, loading: false });
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
  async batchRemove(ids) {
    const res = await batchDeleteRecordings(ids);
    const del = new Set(res.deleted);
    set((s) => ({ items: s.items.filter((r) => !del.has(r.id)), total: Math.max(s.total - del.size, 0) }));
    return res;
  },
  async exportCsv() {
    return exportRecordingsCsv();
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
  upsertRecordingFromEvent(rec) {
    set((s) => {
      const previous = s.items.find((item) => item.id === rec.id);
      const idx = s.items.findIndex((item) => item.id === rec.id);
      const items = idx === -1 ? s.items : s.items.map((item, index) => (index === idx ? normalizeRecording(rec) : item));
      const justCompleted = rec.state === 'completed' && previous?.state !== 'completed';
      return { items, completionNotice: justCompleted ? normalizeRecording(rec) : s.completionNotice };
    });
  },
}));
