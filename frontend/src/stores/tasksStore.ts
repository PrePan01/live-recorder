import { create } from "./createStore";
import { shallow } from "zustand/vanilla/shallow";
import { fetchTasks } from "../api/tasks";
import type { TaskItem } from "../types/tasks";
import type { Recording } from "../types/recording";

export const TASK_DISPLAY_GRACE_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 800;

interface GraceEntry {
  item: TaskItem;
  expiresAt: number;
}

interface TasksState {
  active: TaskItem[];
  grace: Record<string, GraceEntry>;
  scheduleRefresh: () => Promise<void>;
  refresh: () => Promise<void>;
  pruneGrace: (now: number) => void;
  settleRecording: (recording: Recording) => void;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let rerun = false;

function isVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function isTerminalTask(item: TaskItem): boolean {
  return [
    "completed",
    "failed",
    "partial",
    "cancelled",
    "unavailable",
  ].includes(item.state);
}

function terminalItem(item: TaskItem): TaskItem {
  return item.state === "completed"
    ? {
        ...item,
        progressPercent: 100,
        error: null,
        step: null,
        etaSeconds: null,
      }
    : { ...item, etaSeconds: null };
}

function schedulePrune(
  set: (partial: Partial<TasksState>) => void,
  get: () => TasksState,
  grace: Record<string, GraceEntry>,
  now: number,
): void {
  if (pruneTimer) return;
  const entries = Object.values(grace);
  if (entries.length === 0) return;
  const earliest = entries.reduce(
    (min, entry) => Math.min(min, entry.expiresAt),
    now + TASK_DISPLAY_GRACE_MS,
  );
  pruneTimer = setTimeout(
    () => {
      pruneTimer = null;
      const state = get();
      const live = { ...state.grace };
      let changed = false;
      const current = Date.now();
      for (const [id, entry] of Object.entries(live)) {
        if (entry.expiresAt <= current) {
          delete live[id];
          changed = true;
        }
      }
      if (changed) set({ grace: live });
      schedulePrune(set, get, live, current);
    },
    Math.max(0, earliest - now) + 30,
  );
}

export const useTasksStore = create<TasksState>((set, get) => ({
  active: [],
  grace: {},

  async refresh() {
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      let items: TaskItem[];
      try {
        items = await fetchTasks(get().active.map((item) => item.id));
      } catch {
        // 拉取失败不冻结既有展示（断线不冻结；下一次触发再校准）。
        return;
      }
      const now = Date.now();
      const terminal = new Map(
        items
          .filter(isTerminalTask)
          .map((item) => [item.id, terminalItem(item)]),
      );
      items = items.filter((item) => !isTerminalTask(item));
      const previous = get();
      const prevActive = previous.active;
      const grace = { ...previous.grace };
      // 请求返回前 SSE 已确认结束时，不让旧的在途响应把卡片拉回 99%。
      items = items.filter(
        (item) =>
          !grace[item.id] ||
          grace[item.id]!.item.state === "unavailable" ||
          Date.parse(item.updatedAt) >
            Date.parse(grace[item.id]!.item.updatedAt),
      );
      const nextIds = new Set(items.map((item) => item.id));

      for (const item of prevActive) {
        if (nextIds.has(item.id)) continue;
        if (grace[item.id]) continue;
        grace[item.id] = {
          item: terminal.get(item.id) ?? {
            ...item,
            state: "unavailable",
            etaSeconds: null,
          },
          expiresAt: now + TASK_DISPLAY_GRACE_MS,
        };
      }
      for (const item of items) {
        delete grace[item.id];
      }
      const activeChanged =
        items.length !== prevActive.length ||
        items.some((item, index) => !shallow(item, prevActive[index]));
      const graceChanged = !shallow(grace, previous.grace);
      if (activeChanged || graceChanged) {
        set({
          active: activeChanged ? items : prevActive,
          grace: graceChanged ? grace : previous.grace,
        });
      }

      // 宽限到期统一移除（同刻消失的一批一起减、角标同步归零）。
      schedulePrune(set, get, grace, now);
    } finally {
      inFlight = false;
      if (rerun) {
        rerun = false;
        void get().refresh();
      }
    }
  },

  scheduleRefresh() {
    if (!isVisible()) return Promise.resolve();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (isVisible()) void get().refresh();
    }, REFRESH_DEBOUNCE_MS);
    return Promise.resolve();
  },

  settleRecording(rec) {
    if (
      rec.state !== "failed" &&
      (rec.state !== "completed" ||
        rec.pipelineStatus === "queued" ||
        rec.pipelineStatus === "running")
    )
      return;
    const current = get();
    const matches = current.active.filter(
      (item) =>
        (item.kind === "clip" && item.id === rec.id) ||
        (item.kind === "pipeline" && item.recordingId === rec.id),
    );
    if (!matches.length) return;
    const now = Date.now();
    const grace = { ...current.grace };
    for (const item of matches) {
      const state =
        rec.state === "failed" || rec.pipelineStatus === "failed"
          ? "failed"
          : rec.pipelineStatus === "partial"
            ? "partial"
            : "completed";
      grace[item.id] = {
        item: terminalItem({
          ...item,
          title: rec.streamTitle,
          state,
          error:
            state === "failed"
              ? (rec.failureReason?.message ?? "后处理失败")
              : null,
          updatedAt: new Date(now).toISOString(),
        }),
        expiresAt: now + TASK_DISPLAY_GRACE_MS,
      };
    }
    const ids = new Set(matches.map((item) => item.id));
    set({ active: current.active.filter((item) => !ids.has(item.id)), grace });
    schedulePrune(set, get, grace, now);
  },

  pruneGrace(now) {
    const grace = { ...get().grace };
    let changed = false;
    for (const [id, entry] of Object.entries(grace)) {
      if (entry.expiresAt <= now) {
        delete grace[id];
        changed = true;
      }
    }
    if (changed) set({ grace });
    schedulePrune(set, get, grace, now);
  },
}));

export function selectVisibleTasks(state: {
  active: TaskItem[];
  grace: Record<string, GraceEntry>;
}): TaskItem[] {
  return [
    ...state.active,
    ...Object.values(state.grace).map((entry) => entry.item),
  ];
}
