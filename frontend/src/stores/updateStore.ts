import { create } from 'zustand';
import { bridge } from './bootStore';
import type { UpdateState } from '../types/update';

interface Store {
  state: UpdateState | null;
  checking: boolean;
  accept: (state: UpdateState) => void;
  check: () => Promise<UpdateState | null>;
  download: () => Promise<void>;
}
let checking: Promise<UpdateState | null> | null = null;
let downloading: Promise<void> | null = null;
export const useUpdateStore = create<Store>((set, get) => ({
  state: null,
  checking: false,
  accept: (state) => set((previous) => previous.state && previous.state.revision > state.revision ? {} : { state }),
  check: () => {
    if (get().state?.phase === 'downloading') return Promise.resolve(get().state);
    if (checking) return checking;
    set({ checking: true });
    checking = bridge.checkUpdate().then((state) => { get().accept(state); return state; })
      .finally(() => { checking = null; set({ checking: false }); });
    return checking;
  },
  download: () => {
    if (downloading) return downloading;
    downloading = bridge.downloadUpdate().then((state) => { get().accept(state); })
      .finally(() => { downloading = null; });
    return downloading;
  },
}));

/** Subscribe before reading the snapshot; revisions reject late responses. */
export function startUpdateMonitoring(): () => void {
  if (!bridge.isDesktop) return () => {};
  let disposed = false;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  void (async () => {
    try {
      off = await bridge.onUpdateState((state) => { if (!disposed) useUpdateStore.getState().accept(state); });
      if (disposed) { off(); return; }
      const state = await bridge.getUpdateState();
      if (disposed) return;
      useUpdateStore.getState().accept(state);
      const check = () => { void useUpdateStore.getState().check().catch(() => {}); };
      check();
      timer = setInterval(check, 4 * 60 * 60 * 1000);
    } catch {
      // Manual checks still expose actionable errors when initialization fails.
    }
  })();
  return () => { disposed = true; off?.(); if (timer) clearInterval(timer); };
}
