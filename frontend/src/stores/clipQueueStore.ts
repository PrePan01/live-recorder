import { create } from 'zustand';

interface ClipQueueState {
  /** SSE clip-queue:updated 版本戳：变化即代表队列有更新，消费方重拉快照。 */
  version: number;
  touch: () => void;
}

export const useClipQueueStore = create<ClipQueueState>((set) => ({
  version: 0,
  touch() {
    set((state) => ({ version: state.version + 1 }));
  },
}));
