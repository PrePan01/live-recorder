import { create } from "zustand";
import type { StreamHealth } from "../types/streamHealth";
import { fetchActiveRecordingHealth } from "../api/recordings";
import { EndpointResolver } from "../api/endpoint";

interface StreamHealthState {
  byRecording: Record<string, StreamHealth>;
  applyHealth: (health: StreamHealth) => void;
  remove: (id: string) => void;
  reset: () => void;
}

export const useStreamHealthStore = create<StreamHealthState>((set) => ({
  byRecording: {},
  applyHealth(health) {
    if (health.active === false) pendingRemovals?.add(health.recordingId);
    set((state) => {
      const prev = state.byRecording[health.recordingId];
      if ((prev?.sampledAt ?? 0) > (health.sampledAt ?? 0)) return state;
      const next = { ...state.byRecording };
      if (health.active === false) delete next[health.recordingId];
      else next[health.recordingId] = health;
      return { byRecording: next };
    });
  },
  remove(id) {
    pendingRemovals?.add(id);
    set((state) => {
      if (!state.byRecording[id]) return state;
      const next = { ...state.byRecording };
      delete next[id];
      return { byRecording: next };
    });
  },
  reset: () => {
    generation += 1;
    inFlight = null;
    pendingRemovals = null;
    set({ byRecording: {} });
  },
}));

let generation = 0;
let inFlight: Promise<void> | null = null;
let pendingRemovals: Set<string> | null = null;

/** 多个卡片和预览共享一次批量快照；新 SSE 数据不能被旧快照覆盖。 */
export function refreshStreamHealth(): Promise<void> {
  if (inFlight) return inFlight;
  const base = EndpointResolver.base;
  const requestGeneration = generation;
  const before = useStreamHealthStore.getState().byRecording;
  const removed = new Set<string>();
  pendingRemovals = removed;
  const request = fetchActiveRecordingHealth()
    .then((health) => {
      if (base !== EndpointResolver.base || requestGeneration !== generation)
        return;
      const store = useStreamHealthStore.getState();
      const ids = new Set(health.map((h) => h.recordingId));
      for (const id of Object.keys(before)) {
        if (!ids.has(id) && store.byRecording[id] === before[id])
          store.remove(id);
      }
      for (const h of health) {
        if (!removed.has(h.recordingId))
          useStreamHealthStore.getState().applyHealth(h);
      }
    })
    .finally(() => {
      if (inFlight === request) {
        inFlight = null;
        pendingRemovals = null;
      }
    });
  inFlight = request;
  return request;
}

export function selectStreamHealth(
  state: { byRecording: Record<string, StreamHealth> },
  recordingId: string | undefined,
): StreamHealth | null {
  return recordingId ? (state.byRecording[recordingId] ?? null) : null;
}

/** 语义态 → 显示词（悬停/无障碍面）。 */
export function streamHealthText(health: StreamHealth): string {
  switch (health.state) {
    case "good":
      return "录制正常";
    case "degraded":
      return health.issue === "no_data" ? "数据暂时中断" : "录制数据异常";
    case "empty":
      return health.issue === "write_error" ? "录像写入异常" : "长时间无数据";
    default:
      return "状态未知";
  }
}
