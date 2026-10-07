import { create } from "./createStore";
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

function clipWorkFinished(rec: Recording): boolean {
  return rec.state === "failed" ||
    (rec.state === "completed" && rec.pipelineStatus !== "queued" && rec.pipelineStatus !== "running");
}

/**
 * SSE 是增量流，历史页列表不会包含所有录制。单独记录经 SSE 观察到的状态，
 * 才能区分「本次运行中由未完成变为完成」和「启动后首次收到的历史记录更新」
 * （例如完整性校验重跑）。
 */
const eventStateByRecordingId = new Map<string, Recording["state"]>();

/** 列表请求代际：后发先至，旧响应不再覆盖新筛选/翻页的结果。 */
let historyEpoch = 0;

/** 新记录事件无法按分页/筛选语义插行：防抖失效查询、静默重取当前页。 */
let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 导出选区的确认框参数：确认（保留）前零后台动作，保存后才启动导出。 */
export type PendingClipExport = {
  recordingId: string;
  roomId: string;
  startSecond: number;
  endSecond: number;
  defaultName: string;
};

interface RecordingState {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  /** 历史查询是否加载过；未加载过时新事件无需重取（首访自会拉取）。 */
  historyLoaded: boolean;
  query: RecordingQuery;
  fetchHistory: (
    q?: RecordingQuery,
    opts?: { silent?: boolean },
  ) => Promise<void>;
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
  /** 按事件到达顺序逐个询问，队首为 pendingConfirm。 */
  pendingConfirmQueue: Recording[];
  /** #221：清空待确认保留提示（决策后或弹窗关闭）。 */
  clearPendingConfirm: (recordingId?: string) => void;
  /** 导出选区弹框（点导出即弹，保留后才后台导出）；关框/不保留=零动作取消。 */
  pendingClipExport: PendingClipExport | null;
  setPendingClipExport: (prompt: PendingClipExport) => void;
  clearPendingClipExport: () => void;
  /** 已启动的片段导出（片段记录 id → 源录制 id）：同录并行多条各自独立。 */
  clipExports: Record<string, string>;
  beginClipExport: (sourceRecordingId: string, clipRecordingId: string) => void;
  /** 片段导出终态队列（并行多条可能同帧到达），供通知组件逐条消费。 */
  clipDoneQueue: Recording[];
  clearClipDoneQueue: () => void;
  /** SSE 观察到的录制快照（按 id）：供预览等处读取不在历史列表里的活动录制（如 seekIndexState）。 */
  recordingSnapshots: Record<string, Recording>;
  setRecordingSnapshot: (rec: Recording) => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  historyLoaded: false,
  completionNotice: null,
  pendingConfirm: null,
  pendingConfirmQueue: [],
  pendingClipExport: null,
  clipExports: {},
  clipDoneQueue: [],
  recordingSnapshots: {},
  query: {},
  async fetchHistory(q, opts) {
    const query = { ...get().query, ...q };
    const epoch = ++historyEpoch;
    // silent=事件触发的后台重取：不闪加载态、旧列表留在屏上直到新数据到位。
    set(opts?.silent ? { query } : { loading: true, query });
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
        historyLoaded: true,
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
    const known = get().items.some((item) => item.id === rec.id);
    // 列表外的新记录（新录制/新片段）：分页筛选语义无法客户端插行，防抖重取当前页。
    if (!known) {
      const s = get();
      const inScope =
        s.historyLoaded && (!s.query.roomId || s.query.roomId === rec.roomId);
      if (inScope) {
        if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
        historyRefreshTimer = setTimeout(() => {
          historyRefreshTimer = null;
          void get()
            .fetchHistory(undefined, { silent: true })
            .catch(() => undefined);
        }, 800);
      }
    }
    set((s) => {
      const previous = s.items.find((item) => item.id === rec.id);
      const previousEventState = eventStateByRecordingId.get(rec.id);
      const previousSnapshot = s.recordingSnapshots[rec.id];
      const continuingClipPipeline = rec.id in s.clipExports &&
        rec.state === "processing" &&
        (rec.pipelineStatus === "queued" || rec.pipelineStatus === "running");
      if (
        (TERMINAL_STATES.has(previousEventState ?? "pending") ||
          (previous && TERMINAL_STATES.has(previous.state))) &&
        !TERMINAL_STATES.has(rec.state) && !continuingClipPipeline
      )
        return {};
      eventStateByRecordingId.set(rec.id, rec.state);
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
      // 服务重启后的恢复也会把有内容的遗留录制标为 completed；恢复收尾会在
      // 前端重新连上 SSE 后批量发出更新，不能误报为本次刚完成的录制。
      const justCompleted =
        rec.state === "completed" &&
        previousEventState !== undefined &&
        previousEventState !== "completed" &&
        rec.endReason !== "interrupted" &&
        rec.endReason !== "service_restart";
      const justAwaiting =
        rec.state === "awaiting_confirmation" &&
        previousEventState !== "awaiting_confirmation" &&
        previous?.state !== "awaiting_confirmation";
      const trackedClipExport = rec.id in s.clipExports;
      const isClipExport =
        trackedClipExport ||
        rec.origin === "clip" ||
        rec.endReason === "clip_export";
      const clipTerminal =
        isClipExport &&
        clipWorkFinished(rec) &&
        (trackedClipExport ||
          (previousEventState !== undefined &&
            !TERMINAL_STATES.has(previousEventState)));
      let clipExports = s.clipExports;
      if (clipTerminal) {
        clipExports = { ...s.clipExports };
        delete clipExports[rec.id];
      } else if (isClipExport && !clipWorkFinished(rec)) {
        // SSE 可能先于保存请求响应到达；贯穿导出和后处理保留本次任务。
        clipExports = { ...s.clipExports, [rec.id]: s.clipExports[rec.id] ?? rec.id };
      }
      let pendingConfirmQueue = s.pendingConfirmQueue;
      if (rec.state === "awaiting_confirmation") {
        const queued = pendingConfirmQueue.some((item) => item.id === rec.id);
        if (queued) {
          pendingConfirmQueue = pendingConfirmQueue.map((item) =>
            item.id === rec.id ? normalizeRecording(rec) : item,
          );
        } else if (justAwaiting) {
          pendingConfirmQueue = [...pendingConfirmQueue, normalizeRecording(rec)];
        }
      } else {
        // 已决策、导出失败等事件让该项失效，队列中的其他录制继续询问。
        pendingConfirmQueue = pendingConfirmQueue.filter((item) => item.id !== rec.id);
      }
      return {
        items,
        completionNotice:
          justCompleted && !isClipExport
            ? normalizeRecording(rec)
            : s.completionNotice,
        pendingConfirmQueue,
        pendingConfirm: pendingConfirmQueue[0] ?? null,
        clipExports,
        clipDoneQueue:
          clipTerminal && (previousEventState !== rec.state ||
            (trackedClipExport && (!previousSnapshot || !clipWorkFinished(previousSnapshot))))
            ? [...s.clipDoneQueue, normalizeRecording(rec)]
            : s.clipDoneQueue,
        recordingSnapshots: {
          ...s.recordingSnapshots,
          [rec.id]: normalizeRecording(rec),
        },
      };
    });
  },
  removeRecordingFromEvent(recordingId) {
    eventStateByRecordingId.delete(recordingId);
    set((s) => {
      const pendingConfirmQueue = s.pendingConfirmQueue.filter((item) => item.id !== recordingId);
      return {
        items: s.items.filter((item) => item.id !== recordingId),
        total: Math.max(
          0,
          s.total - (s.items.some((item) => item.id === recordingId) ? 1 : 0),
        ),
        pendingConfirmQueue,
        pendingConfirm: pendingConfirmQueue[0] ?? null,
      };
    });
  },
  clearPendingConfirm(recordingId) {
    set((s) => {
      const id = recordingId ?? s.pendingConfirm?.id;
      const pendingConfirmQueue = s.pendingConfirmQueue.filter((item) => item.id !== id);
      return { pendingConfirmQueue, pendingConfirm: pendingConfirmQueue[0] ?? null };
    });
  },
  setPendingClipExport(prompt) {
    set({ pendingClipExport: prompt });
  },
  clearPendingClipExport() {
    set({ pendingClipExport: null });
  },
  beginClipExport(sourceRecordingId, clipRecordingId) {
    set((s) => {
      const snapshot = s.recordingSnapshots[clipRecordingId];
      // 很短的片段可能在响应返回前已经通过 SSE 完成并发出通知。
      if (snapshot && clipWorkFinished(snapshot)) return {};
      return {
        clipExports: { ...s.clipExports, [clipRecordingId]: sourceRecordingId },
      };
    });
  },
  clearClipDoneQueue() {
    set({ clipDoneQueue: [] });
  },
  setRecordingSnapshot(rec) {
    set((s) => ({
      recordingSnapshots: {
        ...s.recordingSnapshots,
        [rec.id]: normalizeRecording(rec),
      },
    }));
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
