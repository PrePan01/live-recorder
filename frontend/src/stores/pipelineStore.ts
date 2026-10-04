import { create } from "./createStore";
import type {
  PipelineArtifact,
  PipelineRun,
  PipelineRunDetail,
} from "../types/pipeline";

type PipelineUpdate = {
  run: PipelineRun;
  artifacts: PipelineArtifact[];
};

interface PipelineState {
  runs: Record<string, PipelineRunDetail>;
  upsert: (update: PipelineUpdate) => void;
  setSnapshot: (recordingId: string, detail: PipelineRunDetail) => void;
}

function revisionOf(detail: PipelineRunDetail): number {
  const run = detail.run;
  if (!run) return 0;
  const timestamp = run.endedAt ?? run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldReplace(
  current: PipelineRunDetail | undefined,
  incoming: PipelineRunDetail,
): boolean {
  if (!current?.run) return incoming.run !== null;
  if (!incoming.run) return false;
  if (current.run.id !== incoming.run.id)
    return Date.parse(incoming.run.createdAt) >= Date.parse(current.run.createdAt);
  return revisionOf(incoming) >= revisionOf(current);
}

/**
 * 进度事件只更新 run 进度时，某些快照可能暂未包含所有产物字段。
 * 对同一 run 保留已经确认的产物信息，避免大小/完成时间被空值短暂擦除。
 */
function mergeArtifacts(
  current: PipelineRunDetail | undefined,
  incoming: PipelineRunDetail,
): PipelineRunDetail {
  if (!current?.run || !incoming.run || current.run.id !== incoming.run.id)
    return incoming;
  const previous = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]));
  const received = new Set(incoming.artifacts.map((artifact) => artifact.id));
  const artifacts = incoming.artifacts.map((artifact) => {
    const prior = previous.get(artifact.id);
    if (!prior) return artifact;
    return {
      ...artifact,
      path: artifact.path ?? prior.path,
      sizeBytes: artifact.sizeBytes ?? prior.sizeBytes,
      startedAt: artifact.startedAt ?? prior.startedAt,
      endedAt: artifact.endedAt ?? prior.endedAt,
      error: artifact.error ?? prior.error,
    };
  });
  // artifact 在管线中只会新增，不会被删除；短暂缺失时继续保留已知节点。
  artifacts.push(...current.artifacts.filter((artifact) => !received.has(artifact.id)));
  return { ...incoming, artifacts };
}

/** 已打开的管线详情通过此 store 接收 SSE 推送，而无需重新打开抽屉。 */
export const usePipelineStore = create<PipelineState>((set) => ({
  runs: {},
  upsert({ run, artifacts }) {
    const { artifacts: _embeddedArtifacts, ...runDetail } = run;
    const detail = { run: runDetail, artifacts };
    set((state) => {
      const current = state.runs[run.recordingId];
      return shouldReplace(current, detail)
        ? { runs: { ...state.runs, [run.recordingId]: mergeArtifacts(current, detail) } }
        : state;
    });
  },
  setSnapshot(recordingId, detail) {
    set((state) => {
      const current = state.runs[recordingId];
      return shouldReplace(current, detail)
        ? { runs: { ...state.runs, [recordingId]: mergeArtifacts(current, detail) } }
        : state;
    });
  },
}));
