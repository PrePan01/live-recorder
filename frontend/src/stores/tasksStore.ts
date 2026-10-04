import { create } from './createStore';
import { shallow } from 'zustand/vanilla/shallow';
import { fetchTasks } from '../api/tasks';
import type { TaskItem } from '../types/tasks';

/**
 * 任务进度聚合 store。
 *
 * 展示口径：
 * - 角标 = 在途清单长度；完成任务展示宽限 5 秒后，弹窗与角标同步消失
 *   （宽限期内仍计数；同刻完成的一批一起减）；
 * - 后端「完成即离在途扫描」——消失的任务由前端留 5 秒展示宽限（后端不存已读）；
 * - 数据 = GET /api/v1/tasks 聚合 + 听现有 SSE（debounce 800ms 重拉）
 *   + 1.2s 前台真轮询兜底，不新增事件契约；SSE 断线角标不冻结、重连校准。
 *
 * ⚠ 反饥饿：debounce 重拉在密集事件段会被无限重置
 * （任务正在变化的时刻恰恰拉不成）——轮询必须**直调 refresh()**（真轮询），
 * 绝不能与 debounce 共用一个入口；debounce 只负责 SSE 突发的合并降频。
 */
export const TASK_DISPLAY_GRACE_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 800;

interface GraceEntry {
  item: TaskItem;
  expiresAt: number;
}

interface TasksState {
  active: TaskItem[];
  grace: Record<string, GraceEntry>;
  /** SSE 触发源 → debounce 800ms 后重拉（同一拍多次事件只拉一次）。 */
  scheduleRefresh: () => Promise<void>;
  /** 立即重拉（挂载/轮询/重连校准用；在途护栏防竞写）。 */
  refresh: () => Promise<void>;
  /** 到期宽限项移除（定时器调用）。 */
  pruneGrace: (now: number) => void;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let rerun = false;

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
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
  const earliest = entries.reduce((min, entry) => Math.min(min, entry.expiresAt), now + TASK_DISPLAY_GRACE_MS);
  pruneTimer = setTimeout(() => {
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
  }, Math.max(0, earliest - now) + 30);
}

export const useTasksStore = create<TasksState>((set, get) => ({
  active: [],
  grace: {},

  async refresh() {
    // 在途护栏：并发触发只补拉一次，避免双 fetch 竞写。
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      let items: TaskItem[];
      try {
        items = await fetchTasks();
      } catch {
        // 拉取失败不冻结既有展示（断线不冻结；下一次触发再校准）。
        return;
      }
      const now = Date.now();
      const nextIds = new Set(items.map((item) => item.id));
      const previous = get();
      const prevActive = previous.active;
      const grace = { ...previous.grace };

      // 消失的在途任务进入 5 秒展示宽限（重现（如失败重试）即归位）。
      for (const item of prevActive) {
        if (nextIds.has(item.id)) continue;
        grace[item.id] = { item, expiresAt: now + TASK_DISPLAY_GRACE_MS };
      }
      for (const item of items) {
        delete grace[item.id];
      }
      // TaskItem 是扁平 DTO。相同响应保留快照，尤其空任务轮询不能持续
      // 向 useSyncExternalStore 发布同步更新（后台 WebKit 可能延迟调度）。
      const activeChanged = items.length !== prevActive.length ||
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

/** 当前展示清单 = 在途 + 宽限期（角标数 = 清单长度，宽限期内仍计数）。 */
export function selectVisibleTasks(state: {
  active: TaskItem[];
  grace: Record<string, GraceEntry>;
}): TaskItem[] {
  return [...state.active, ...Object.values(state.grace).map((entry) => entry.item)];
}
