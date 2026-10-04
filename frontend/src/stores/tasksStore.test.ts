import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectVisibleTasks, TASK_DISPLAY_GRACE_MS, useTasksStore } from './tasksStore';
import type { TaskItem } from '../types/tasks';

vi.mock('../api/tasks', () => ({
  fetchTasks: vi.fn(),
}));

import { fetchTasks } from '../api/tasks';

const task = (id: string, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  kind: 'clip',
  title: `标题-${id}`,
  state: 'processing',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra,
});

const flush = async () => {
  await vi.advanceTimersByTimeAsync(900); // debounce 800ms
  await Promise.resolve();
};

describe('任务进度聚合 store（#103）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTasksStore.setState({ active: [], grace: {} });
    vi.mocked(fetchTasks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续空响应不发布新快照（无任务时不触发 React 同步更新）', async () => {
    vi.mocked(fetchTasks).mockImplementation(async () => []);
    const initial = useTasksStore.getState();
    const listener = vi.fn();
    const unsubscribe = useTasksStore.subscribe(listener);
    try {
      for (let i = 0; i < 100; i++) await useTasksStore.getState().refresh();
      expect(useTasksStore.getState()).toBe(initial);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('相同任务响应保留引用，进度变化仍通知且保留完成宽限', async () => {
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a', { progressPercent: 10 })]);
    await useTasksStore.getState().refresh();
    const initial = useTasksStore.getState();
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a', { progressPercent: 10 })]);
    await useTasksStore.getState().refresh();
    expect(useTasksStore.getState()).toBe(initial);
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a', { progressPercent: 20 })]);
    await useTasksStore.getState().refresh();
    expect(useTasksStore.getState().active[0]?.progressPercent).toBe(20);
    vi.mocked(fetchTasks).mockResolvedValueOnce([]);
    await useTasksStore.getState().refresh();
    const graceState = useTasksStore.getState();
    vi.mocked(fetchTasks).mockResolvedValueOnce([]);
    await useTasksStore.getState().refresh();
    expect(useTasksStore.getState()).toBe(graceState);
    await vi.advanceTimersByTimeAsync(TASK_DISPLAY_GRACE_MS + 100);
    expect(selectVisibleTasks(useTasksStore.getState())).toEqual([]);
  });

  it('后台不安排 SSE 补拉，已安排的补拉在切后台后也跳过', async () => {
    const document = { visibilityState: 'hidden' };
    vi.stubGlobal('document', document);
    vi.mocked(fetchTasks).mockResolvedValue([]);
    try {
      await useTasksStore.getState().scheduleRefresh();
      await flush();
      expect(fetchTasks).not.toHaveBeenCalled();
      document.visibilityState = 'visible';
      await useTasksStore.getState().scheduleRefresh();
      document.visibilityState = 'hidden';
      await flush();
      expect(fetchTasks).not.toHaveBeenCalled();
      document.visibilityState = 'visible';
      await useTasksStore.getState().scheduleRefresh();
      await flush();
      expect(fetchTasks).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('宽限：完成即离的任务留 5 秒展示（角标仍计数）后同批归零', async () => {
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a'), task('b')]);
    await useTasksStore.getState().refresh();
    expect(selectVisibleTasks(useTasksStore.getState()).map((t) => t.id)).toEqual(['a', 'b']);

    // 两个任务同刻完成（后端完成即离在途扫描）→ 同进宽限。
    vi.mocked(fetchTasks).mockResolvedValueOnce([]);
    await useTasksStore.getState().refresh();
    let visible = selectVisibleTasks(useTasksStore.getState());
    expect(visible.map((t) => t.id).sort()).toEqual(['a', 'b']); // 宽限期内仍展示、仍计数

    await vi.advanceTimersByTimeAsync(TASK_DISPLAY_GRACE_MS + 100);
    visible = selectVisibleTasks(useTasksStore.getState());
    expect(visible).toEqual([]); // 同刻归零（弹窗与角标同步消失）
  });

  it('宽限中途重现（如失败重试）即归位、不等宽限到期', async () => {
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a')]);
    await useTasksStore.getState().refresh();
    vi.mocked(fetchTasks).mockResolvedValueOnce([]);
    await useTasksStore.getState().refresh();
    expect(selectVisibleTasks(useTasksStore.getState()).map((t) => t.id)).toEqual(['a']);

    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a', { state: 'running' })]);
    await useTasksStore.getState().refresh();
    const state = useTasksStore.getState();
    expect(selectVisibleTasks(state).map((t) => t.id)).toEqual(['a']);
    expect(Object.keys(state.grace)).toEqual([]);
    expect(state.active[0]?.state).toBe('running');
  });

  it('失败文案随行（error 字段原样带出）', async () => {
    vi.mocked(fetchTasks).mockResolvedValueOnce([
      task('f', { state: 'queued', error: '上传失败，可重试' }),
    ]);
    await useTasksStore.getState().refresh();
    const visible = selectVisibleTasks(useTasksStore.getState());
    expect(visible[0]?.error).toBe('上传失败，可重试');
  });

  it('debounce：同一拍多次触发只重拉一次（800ms）', async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task('a')]);
    void useTasksStore.getState().scheduleRefresh();
    void useTasksStore.getState().scheduleRefresh();
    void useTasksStore.getState().scheduleRefresh();
    expect(fetchTasks).not.toHaveBeenCalled();
    await flush();
    expect(fetchTasks).toHaveBeenCalledTimes(1);
  });

  it('反饥饿（QA p0v）：密集事件无限重置 debounce 时，直调 refresh（真轮询）仍立即拉到', async () => {
    vi.mocked(fetchTasks).mockResolvedValue([task('a')]);
    // 密集事件：每 300ms 一次 scheduleRefresh（尾 debounce 永不触发）。
    for (let i = 0; i < 6; i++) {
      void useTasksStore.getState().scheduleRefresh();
      await vi.advanceTimersByTimeAsync(300);
      if (i === 3) await useTasksStore.getState().refresh(); // 轮询直调
    }
    expect(fetchTasks).toHaveBeenCalled(); // 真轮询拉到了（非饿死）
    expect(selectVisibleTasks(useTasksStore.getState()).map((t) => t.id)).toEqual(['a']);
  });

  it('在途护栏：并发 refresh 只发一次请求并补拉一次', async () => {
    let resolveFirst: (value: TaskItem[]) => void = () => undefined;
    vi.mocked(fetchTasks)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue([task('b')]);
    const p1 = useTasksStore.getState().refresh();
    const p2 = useTasksStore.getState().refresh(); // 在途 → 记为补拉
    resolveFirst([task('a')]);
    await p1;
    await p2;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(fetchTasks).toHaveBeenCalledTimes(2); // 1 次主拉 + 1 次补拉（无双跑竞写）
  });

  it('拉取失败不冻结既有展示（断线不冻结）', async () => {
    vi.mocked(fetchTasks).mockResolvedValueOnce([task('a')]);
    await useTasksStore.getState().refresh();
    vi.mocked(fetchTasks).mockRejectedValueOnce(new Error('offline'));
    await useTasksStore.getState().refresh();
    expect(selectVisibleTasks(useTasksStore.getState()).map((t) => t.id)).toEqual(['a']);
  });
});
