import { create } from 'zustand';
import type { AppInstance, BootEvent, BootState, DiagnosticItem } from '../types/desktop';
import { detectBridge } from '../bridge/nativeBridge';
import { useServiceStore } from './serviceStore';
import { EndpointResolver } from '../api/endpoint';

export const bridge = detectBridge();

// 原生启动/停止可能因残留进程或 I/O 挂起；页面必须有可恢复的终态。
const BOOT_TIMEOUT_MS = 60_000;
async function withBootTimeout(operation: Promise<BootEvent>): Promise<BootEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('本地服务启动超过 60 秒，请查看诊断后重试。')), BOOT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

export const useBootStore = create<BootStateStore>((set, get) => ({
  state: 'booting',
  instance: null,
  diagnostics: [],
  loading: false,
  async boot() {
    if (get().loading) return;
    set({ loading: true, state: 'booting' });
    try {
      const event = await withBootTimeout(bridge.startService());
      if (event.instance) EndpointResolver.set(event.instance);
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch (error) {
      set({ state: 'degraded', loading: false, diagnostics: [{ key: 'service', message: '本地服务启动失败', detail: String(error) }] });
    }
  },
  async restart() {
    if (get().loading) return;
    set({ loading: true, state: 'booting' });
    try {
      const event = await withBootTimeout(bridge.restartService());
      if (event.instance) EndpointResolver.set(event.instance);
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    } catch (error) {
      set({ state: 'degraded', loading: false, diagnostics: [{ key: 'service', message: '本地服务重启失败', detail: String(error) }] });
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
      setState('existing-instance');
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
