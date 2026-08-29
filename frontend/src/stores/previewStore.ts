import { create } from 'zustand';

const MAX_PREVIEWS = 4;

interface PreviewState {
  openRoomIds: string[];
  /** 返回 false 表示已达全局预览上限 */
  open: (roomId: string) => boolean;
  close: (roomId: string) => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  openRoomIds: [],
  open(roomId) {
    const { openRoomIds } = get();
    if (openRoomIds.includes(roomId)) return true;
    if (openRoomIds.length >= MAX_PREVIEWS) return false;
    set({ openRoomIds: [...openRoomIds, roomId] });
    return true;
  },
  close(roomId) {
    set((s) => ({ openRoomIds: s.openRoomIds.filter((id) => id !== roomId) }));
  },
}));
