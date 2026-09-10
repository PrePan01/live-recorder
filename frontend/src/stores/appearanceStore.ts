import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface AppearanceState {
  showGlobalSearch: boolean;
  setShowGlobalSearch: (show: boolean) => void;
}

// Display preferences belong to this client and are independent of service settings.
export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      showGlobalSearch: false,
      setShowGlobalSearch: (showGlobalSearch) => set({ showGlobalSearch }),
    }),
    {
      name: 'live-recorder-appearance',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ showGlobalSearch }) => ({ showGlobalSearch }),
    },
  ),
);
