import { create } from 'zustand';
import type { DanmakuStatus } from '../types/danmaku';

interface DanmakuState {
  /** 各录制的弹幕采集状态（SSE danmaku:status 与读取口快照共写）。 */
  statusByRecording: Record<string, DanmakuStatus>;
  applyStatus: (status: DanmakuStatus) => void;
}

export const useDanmakuStore = create<DanmakuState>((set) => ({
  statusByRecording: {},
  applyStatus(status) {
    set((state) => ({
      statusByRecording: { ...state.statusByRecording, [status.recordingId]: status },
    }));
  },
}));

export function selectDanmakuStatus(
  state: { statusByRecording: Record<string, DanmakuStatus> },
  recordingId: string | undefined,
): DanmakuStatus | null {
  return recordingId ? state.statusByRecording[recordingId] ?? null : null;
}

/** 采集状态的人话文案（四态）。 */
export function danmakuStateText(state: DanmakuStatus['state']): string {
  switch (state) {
    case 'connecting':
      return '弹幕连接中';
    case 'collecting':
      return '弹幕采集中';
    case 'reconnecting':
      return '弹幕重连中';
    default:
      return '弹幕暂不可用';
  }
}
