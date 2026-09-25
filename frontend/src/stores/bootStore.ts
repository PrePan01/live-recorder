import { create } from 'zustand';
import type {
  AppInstance,
  BootEvent,
  BootState,
  DiagnosticItem,
} from '../types/desktop';
import { detectBridge } from '../bridge/nativeBridge';
import { useServiceStore } from './serviceStore';
import { EndpointResolver } from '../api/endpoint';
import { setErrorDiagnosticContext } from '../utils/errorDiagnostics';

export const bridge = detectBridge();

/** 启动/重启等待上限：原生进程卡死时降级到既有的可重试错误页，而不是永久停在「加载中」。 */
const START_TIMEOUT_MS = 30_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 实例解析代际：作废迟到的 getAppInstance 结果，防止快速重启后回写旧端口。 */
let instanceSeq = 0;

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
    const applySuccess = (event: BootEvent) => {
      if (event.instance) {
        instanceSeq += 1;
        if (EndpointResolver.instanceId !== event.instance.instanceId) {
          useServiceStore.setState({
            status: null,
            loading: false,
            error: null,
          });
        }
        EndpointResolver.set(event.instance);
        setErrorDiagnosticContext({ instanceId: event.instance.instanceId });
      }
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    };
    let raw: Promise<BootEvent> | null = null;
    try {
      raw = bridge.startService();
      // 超时后原生结果弃用；吞掉其迟到的 rejection，避免孤儿未处理异常。
      raw.catch(() => undefined);
      applySuccess(
        await withTimeout(raw, START_TIMEOUT_MS, "本地服务启动超时（30 秒未就绪）"),
      );
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
      // 超时降级后原生若自行就绪且期间无人重试：静默补成功
      //（保留「最终成功无需重试」的既有语义，用户不用白点一次重试）。
      raw
        ?.then((late) => {
          const snapshot = get();
          if (snapshot.state === 'degraded' && !snapshot.loading) {
            applySuccess(late);
          }
        })
        .catch(() => undefined);
    } finally {
      clearTimeout(timer);
      set({ slow: false });
    }
  },
  async restart() {
    if (get().loading) return;
    set({ loading: true, slow: false, state: 'booting', diagnostics: [] });
    const timer = setTimeout(() => set({ slow: true }), 15_000);
    const applySuccess = (event: BootEvent) => {
      if (event.instance) {
        instanceSeq += 1;
        if (EndpointResolver.instanceId !== event.instance.instanceId) {
          useServiceStore.setState({
            status: null,
            loading: false,
            error: null,
          });
        }
        EndpointResolver.set(event.instance);
        setErrorDiagnosticContext({ instanceId: event.instance.instanceId });
      }
      set({
        state: event.state,
        instance: event.instance ?? null,
        diagnostics: event.diagnostics,
        loading: false,
      });
    };
    let raw: Promise<BootEvent> | null = null;
    try {
      raw = bridge.restartService();
      raw.catch(() => undefined);
      applySuccess(
        await withTimeout(raw, START_TIMEOUT_MS, "本地服务重启超时（30 秒未就绪）"),
      );
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
      raw
        ?.then((late) => {
          const snapshot = get();
          if (snapshot.state === 'degraded' && !snapshot.loading) {
            applySuccess(late);
          }
        })
        .catch(() => undefined);
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
    instanceSeq += 1;
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
        // Automatic backend recovery can allocate a new local port/instance.
        // Resolve it before the next SSE/API request so the recovered process
        // is actually used instead of leaving the UI on a stale endpoint.
        if (state === 'ready') {
          const seq = ++instanceSeq;
          void bridge.getAppInstance().then((instance) => {
            // 迟到的解析结果作废：期间若有更新的启动/重启/实例切换，以最新为准。
            if (!instance || seq !== instanceSeq) return;
            if (EndpointResolver.instanceId !== instance.instanceId) {
              useServiceStore.setState({ status: null, loading: false, error: null });
            }
            EndpointResolver.set(instance);
            setErrorDiagnosticContext({ instanceId: instance.instanceId });
            useBootStore.getState().setInstance(instance);
          });
        }
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
