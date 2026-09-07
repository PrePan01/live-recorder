import { create } from 'zustand';
import type { AppInstance, BootState, DiagnosticItem } from '../types/desktop';
import { detectBridge } from '../bridge/nativeBridge';
import { useServiceStore } from './serviceStore';
import { EndpointResolver } from '../api/endpoint';

export const bridge = detectBridge();

interface BootStateStore {
  state: BootState;
  instance: AppInstance | null;
  diagnostics: DiagnosticItem[];
  loading: boolean;
  slow: boolean;
  boot: () => Promise<void>;
  restart: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  setState: (s: BootState) => void;
  setInstance: (i: AppInstance | null) => void;
  setDiagnostics: (d: DiagnosticItem[]) => void;
}

export const useBootStore = create<BootStateStore>((set, get) => ({
  state: 'booting',
  instance: null,
  diagnostics: [],
  loading: false,
  slow: false,
  async boot() {
    if (get().loading) return;
    set({ loading: true, slow: false, state: 'booting', diagnostics: [] });
    const timer = setTimeout(() => set({ slow: true }), 15_000);
    try {
      const event = await bridge.startService();
      if (event.instance) {
        if (EndpointResolver.instanceId !== event.instance.instanceId) {
          useServiceStore.setState({
            status: null,
            loading: false,
            error: null,
          });
        }
        EndpointResolver.set(event.instance);
      }
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch (error) {
      set({
        state: 'degraded',
        loading: false,
        diagnostics: [
          {
            key: 'service',
            message: '本地服务启动失败',
            detail: String(error),
          },
        ],
      });
    } finally {
      clearTimeout(timer);
      set({ slow: false });
    }
  },
  async restart() {
    if (get().loading) return;
    set({ loading: true, slow: false, state: 'booting', diagnostics: [] });
    const timer = setTimeout(() => set({ slow: true }), 15_000);
    try {
      const event = await bridge.restartService();
      if (event.instance) {
        if (EndpointResolver.instanceId !== event.instance.instanceId) {
          useServiceStore.setState({
            status: null,
            loading: false,
            error: null,
          });
        }
        EndpointResolver.set(event.instance);
      }
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch (error) {
      set({
        state: 'degraded',
        loading: false,
        diagnostics: [
          {
            key: 'service',
            message: '本地服务重启失败',
            detail: String(error),
          },
        ],
      });
    } finally {
      clearTimeout(timer);
      set({ slow: false });
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
  setInstance: (i) => {
    EndpointResolver.set(i);
    set({ instance: i });
  },
  setDiagnostics: (d) => set({ diagnostics: d }),
}));

export function subscribeBridgeEvents() {
  const { setState, restart } = useBootStore.getState();
  const disposers: (() => void)[] = [];

  disposers.push(
    bridge.onBootState((state) => {
      if (state === 'existing-instance') {
        setState('existing-instance');
      } else if (state === 'ready' || state === 'degraded') {
        void useBootStore.getState().refreshDiagnostics();
      } else if (state !== 'booting') {
        // 启动命令的返回值负责完成状态切换，延迟的原生 booting 事件不能倒退已完成的启动。
        setState(state);
      }
    }),
  );
  disposers.push(
    bridge.onExistingInstance(() => {
      /* 已有主窗口仅被唤醒，不改变工作台状态。 */
    }),
  );
  disposers.push(
    bridge.onTray((action) => {
      if (action === 'restart') void restart();
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
