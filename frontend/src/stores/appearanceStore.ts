import { create } from './createStore';
import { createJSONStorage, persist } from 'zustand/middleware';

interface AppearanceState {
  showGlobalSearch: boolean;
  setShowGlobalSearch: (show: boolean) => void;
  showStatusBarAlerts: boolean;
  setShowStatusBarAlerts: (show: boolean) => void;
  showLiveRoomCover: boolean;
  setShowLiveRoomCover: (show: boolean) => void;
}

// Display preferences belong to this client and are independent of service settings.
export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      showGlobalSearch: false,
      setShowGlobalSearch: (showGlobalSearch) => set({ showGlobalSearch }),
      showStatusBarAlerts: false,
      setShowStatusBarAlerts: (showStatusBarAlerts) => set({ showStatusBarAlerts }),
      showLiveRoomCover: true,
      setShowLiveRoomCover: (showLiveRoomCover) => set({ showLiveRoomCover }),
    }),
    {
      name: 'live-recorder-appearance',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ showGlobalSearch, showStatusBarAlerts, showLiveRoomCover }) => ({ showGlobalSearch, showStatusBarAlerts, showLiveRoomCover }),
    },
  ),
);
