import { create } from "zustand";
import {
  fetchRecordings,
  openRecordingDirectory,
  renameRecording,
  deleteRecording,
  batchDeleteRecordings,
  exportRecordingsCsv,
} from "../api/recordings";
import type {
  Recording,
  RecordingQuery,
  UploadSnapshot,
} from "../types/recording";

function normalizeRecording(rec: Recording): Recording {
  return { ...rec, integrity: rec.integrity ?? null };
}

const TERMINAL_STATES = new Set<Recording["state"]>(["completed", "failed"]);

/** 列表请求代际：后发先至，旧响应不再覆盖新筛选/翻页的结果。 */
let historyEpoch = 0;

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
  batchRemove: (ids: string[]) => Promise<{
    deleted: string[];
    failed: Array<{ id: string; reason: string }>;
  }>;
  exportCsv: () => Promise<string>;
  upsertRecording: (rec: Recording) => void;
  /** 仅由 SSE 写入，用于避免打开历史页时把旧记录误报成刚完成。 */
  upsertRecordingFromEvent: (rec: Recording) => void;
  removeRecordingFromEvent: (recordingId: string) => void;
  /** SSE upload:updated 按 recordingId 更新对应录制的上传快照（#191）。 */
  patchRecordingUpload: (
    recordingId: string,
    upload: UploadSnapshot | null,
  ) => void;
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
    const epoch = ++historyEpoch;
    set({ loading: true, query });
    try {
      const res = await fetchRecordings(query);
      // 旧代际响应直接丢弃：快速切筛选/连点翻页时以最后一次请求为准。
      if (epoch !== historyEpoch) return;
      set({
        items: res.items.map(normalizeRecording),
        total: res.total,
        page: res.page,
        pageSize: res.pageSize,
        loading: false,
      });
    } catch (error) {
      if (epoch !== historyEpoch) return;
      set({ loading: false });
      // 失败上抛给页面提示，不再静默吞掉（旧列表会停在屏上无任何反馈）。
      throw error;
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
    set((s) => ({
      items: s.items.filter((r) => r.id !== id),
      total: Math.max(s.total - 1, 0),
    }));
  },
  async batchRemove(ids) {
    const res = await batchDeleteRecordings(ids);
    const del = new Set(res.deleted);
    set((s) => ({
      items: s.items.filter((r) => !del.has(r.id)),
      total: Math.max(s.total - del.size, 0),
    }));
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
      // SSE may reconnect after a slow client was dropped. A delayed progress
      // frame must never turn a terminal recording back into recording/pending.
      if (
        previous &&
        TERMINAL_STATES.has(previous.state) &&
        !TERMINAL_STATES.has(rec.state)
      )
        return {};
      const idx = s.items.findIndex((item) => item.id === rec.id);
      const items =
        idx === -1
          ? s.items
          : s.items.map((item, index) =>
              index === idx
                ? {
                    ...normalizeRecording(rec),
                    upload: rec.upload ?? item.upload ?? null,
                  }
                : item,
            );
      // 中断收尾的录制同样是 completed，但它不是"正常录完"：由失败告警说明，
      // 这里不再弹"录制完成"，避免同一次录制同时收到"完成"和"失败"两条互相打架的提示。
      const justCompleted =
        rec.state === "completed" &&
        previous?.state !== "completed" &&
        rec.endReason !== "interrupted";
      // #220/#221：进入「待确认保留」态时提示用户（挂起管线/上传，等用户决策保留/删除）。
      const justAwaiting =
        rec.state === "awaiting_confirmation" &&
        previous?.state !== "awaiting_confirmation";
      return {
        items,
        completionNotice: justCompleted
          ? normalizeRecording(rec)
          : s.completionNotice,
        pendingConfirm: justAwaiting
          ? normalizeRecording(rec)
          : // 精彩时刻导出失败可能发生在确认框已提前打开之后；收到失败事件时
            // 收起已无效的确认框，避免用户提交一个不存在的待确认记录。
            s.pendingConfirm?.id === rec.id &&
              rec.state !== "awaiting_confirmation"
            ? null
            : s.pendingConfirm,
      };
    });
  },
  removeRecordingFromEvent(recordingId) {
    set((s) => ({
      items: s.items.filter((item) => item.id !== recordingId),
      total: Math.max(0, s.total - (s.items.some((item) => item.id === recordingId) ? 1 : 0)),
      pendingConfirm:
        s.pendingConfirm?.id === recordingId ? null : s.pendingConfirm,
    }));
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
