import { create } from 'zustand';

/** Preview decoding sessions are deliberately capped independently of recording. */
const MAX_PREVIEWS = 4;

export interface PreviewModalConfig {
  roomId: string;
  titlePrefix?: string;
  defaultWidth?: number;
  enableHighlights?: boolean;
}

interface PreviewState {
  openRoomIds: string[];
  /** 应用级观看弹窗；挂在布局层，路由切换时仍保留画中画播放器。 */
  activeModal: PreviewModalConfig | null;
  /** 返回 false 表示已达全局预览上限 */
  open: (roomId: string) => boolean;
  close: (roomId: string) => void;
  /** 打开应用级观看弹窗，同时占用一个预览会话。 */
  openModal: (config: PreviewModalConfig) => boolean;
  closeModal: () => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  openRoomIds: [],
  activeModal: null,
  open(roomId) {
    const { openRoomIds } = get();
    if (openRoomIds.includes(roomId)) return true;
    if (openRoomIds.length >= MAX_PREVIEWS) return false;
    set({ openRoomIds: [...openRoomIds, roomId] });
    return true;
  },
  close(roomId) {
    set((s) => ({
      openRoomIds: s.openRoomIds.filter((id) => id !== roomId),
      activeModal:
        s.activeModal?.roomId === roomId ? null : s.activeModal,
    }));
  },
  openModal(config) {
    const { openRoomIds } = get();
    if (!openRoomIds.includes(config.roomId)) {
      if (openRoomIds.length >= MAX_PREVIEWS) return false;
      set({
        openRoomIds: [...openRoomIds, config.roomId],
        activeModal: config,
      });
      return true;
    }
    set({ activeModal: config });
    return true;
  },
  closeModal() {
    const { activeModal } = get();
    if (!activeModal) return;
    set((s) => ({
      activeModal: null,
      openRoomIds: s.openRoomIds.filter((id) => id !== activeModal.roomId),
    }));
  },
}));
