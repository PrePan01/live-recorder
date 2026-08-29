import { create } from 'zustand';
import type { AppInstance, BootState, DiagnosticItem } from '../types/desktop';
import { detectBridge } from '../bridge/nativeBridge';
import { useServiceStore } from './serviceStore';

export const bridge = detectBridge();

interface BootStateStore {
  state: BootState;
  instance: AppInstance | null;
  diagnostics: DiagnosticItem[];
  loading: boolean;
  boot: () => Promise<void>;
  restart: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  setState: (s: BootState) => void;
  setInstance: (i: AppInstance | null) => void;
  setDiagnostics: (d: DiagnosticItem[]) => void;
}

export const useBootStore = create<BootStateStore>((set) => ({
  state: 'booting',
  instance: null,
  diagnostics: [],
  loading: false,
  async boot() {
    set({ loading: true, state: 'booting' });
    try {
      const event = await bridge.startService();
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch {
      set({ state: 'degraded', loading: false });
    }
  },
  async restart() {
    set({ loading: true });
    try {
      const event = await bridge.restartService();
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch {
      set({ state: 'degraded', loading: false });
    }
  },
  async refreshDiagnostics() {
    try {
      set({ diagnostics: await bridge.getDiagnostics() });
    } catch {
      /* 忽略 */
    }
  },
  setState: (s) => set({ state: s }),
  setInstance: (i) => set({ instance: i }),
  setDiagnostics: (d) => set({ diagnostics: d }),
}));

export function subscribeBridgeEvents() {
  const { setState, boot } = useBootStore.getState();
  const disposers: (() => void)[] = [];

  disposers.push(
    bridge.onBootState((state) => {
      if (state === 'existing-instance') {
        setState('existing-instance');
      } else if (state === 'ready' || state === 'degraded') {
        void useBootStore.getState().refreshDiagnostics();
      } else {
        setState(state);
      }
    }),
  );
  disposers.push(
    bridge.onExistingInstance(() => {
      setState('existing-instance');
    }),
  );
  disposers.push(
    bridge.onTray((action) => {
      if (action === 'restart') void boot();
      if (action === 'diagnostics') setState('degraded');
      if (action === 'quit') {
        const active = useServiceStore.getState().status?.activeRecordings ?? 0;
        const message =
          active > 0
            ? `当前有 ${active} 个录制任务进行中，退出将停止服务并中断录制，确定退出吗？`
            : '确定退出应用吗？退出将停止本地服务。';
        // eslint-disable-next-line no-alert
        if (window.confirm(message)) void bridge.quit();
      }
    }),
  );

  return () => disposers.forEach((d) => d());
}