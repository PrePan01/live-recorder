import { create } from 'zustand';
import {
  fetchRecordings,
  openRecordingDirectory,
  renameRecording,
  deleteRecording,
  batchDeleteRecordings,
  exportRecordingsCsv,
} from '../api/recordings';
import type { Recording, RecordingQuery, UploadSnapshot } from '../types/recording';

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
  /** SSE upload:updated 按 recordingId 更新对应录制的上传快照（#191）。 */
  patchRecordingUpload: (recordingId: string, upload: UploadSnapshot | null) => void;
  completionNotice: Recording | null;
  /** #220/#221：录制完成进入「待确认保留」态的录制（SSE recording:updated 到 awaiting_confirmation 时设置）。 */
  pendingConfirm: Recording | null;
  /** #221：清空待确认保留提示（决策后或弹窗关闭）。 */
  clearPendingConfirm: () => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  completionNotice: null,
  pendingConfirm: null,
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
      // recording:updated 不携带上传快照；保留 SSE upload:updated 已写入的实时进度。
      next[idx] = { ...rec, upload: rec.upload ?? next[idx]!.upload ?? null };
      return { items: next };
    });
  },
  upsertRecordingFromEvent(rec) {
    set((s) => {
      const previous = s.items.find((item) => item.id === rec.id);
      const idx = s.items.findIndex((item) => item.id === rec.id);
      const items = idx === -1
        ? s.items
        : s.items.map((item, index) => (
            index === idx
              ? { ...normalizeRecording(rec), upload: rec.upload ?? item.upload ?? null }
              : item
          ));
      const justCompleted = rec.state === 'completed' && previous?.state !== 'completed';
      // #220/#221：进入「待确认保留」态时提示用户（挂起管线/上传，等用户决策保留/删除）。
      const justAwaiting = rec.state === 'awaiting_confirmation' && previous?.state !== 'awaiting_confirmation';
      return {
        items,
        completionNotice: justCompleted ? normalizeRecording(rec) : s.completionNotice,
        pendingConfirm: justAwaiting ? normalizeRecording(rec) : s.pendingConfirm,
      };
    });
  },
  clearPendingConfirm() {
    set({ pendingConfirm: null });
  },
  patchRecordingUpload(recordingId, upload) {
    set((s) => {
      const idx = s.items.findIndex((item) => item.id === recordingId);
      if (idx === -1) return {};
      const next = [...s.items];
      next[idx] = { ...next[idx], upload };
      return { items: next };
    });
  },
}));
