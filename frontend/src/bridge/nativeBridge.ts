import type {
  AppInstance,
  BootEvent,
  BootState,
  DiagnosticItem,
  Health,
} from '../types/desktop';

export interface NativeBridge {
  readonly isDesktop: boolean;
  getAppInstance(): Promise<AppInstance | null>;
  getHealth(): Promise<Health | null>;
  startService(): Promise<BootEvent>;
  stopService(): Promise<void>;
  restartService(): Promise<BootEvent>;
  getDiagnostics(): Promise<DiagnosticItem[]>;
  quit(): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  onBootState(cb: (state: BootState) => void): () => void;
  onTray(cb: (action: 'restart' | 'diagnostics' | 'quit') => void): () => void;
  onExistingInstance(cb: () => void): () => void;
}

const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function detectBridge(): NativeBridge {
  return isTauriRuntime() ? new TauriBridge() : new BrowserBridge();
}

class TauriBridge implements NativeBridge {
  readonly isDesktop = true;

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }

  async getAppInstance(): Promise<AppInstance | null> {
    try {
      return (await this.invoke<AppInstance | null>('get_app_instance')) ?? null;
    } catch {
      return null;
    }
  }

  async getHealth(): Promise<Health | null> {
    try {
      return (await this.invoke<Health | null>('get_health')) ?? null;
    } catch {
      return null;
    }
  }

  async startService(): Promise<BootEvent> {
    return this.invoke<BootEvent>('start_service');
  }

  async stopService(): Promise<void> {
    await this.invoke<void>('stop_service');
  }

  async restartService(): Promise<BootEvent> {
    return this.invoke<BootEvent>('restart_service');
  }

  async getDiagnostics(): Promise<DiagnosticItem[]> {
    return this.invoke<DiagnosticItem[]>('get_diagnostics');
  }

  async quit(): Promise<void> {
    await this.invoke<void>('quit_app');
  }

  async notify(title: string, body: string): Promise<void> {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  }

  async pickDirectory(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false });
    return typeof result === 'string' ? result : null;
  }

  async openPath(path: string): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(path);
  }

  onBootState(cb: (state: BootState) => void): () => void {
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisten = await listen<BootState>('boot:state', (e) => cb(e.payload));
    });
    return () => unlisten?.();
  }

  onTray(cb: (action: 'restart' | 'diagnostics' | 'quit') => void): () => void {
    const disposers: (() => void)[] = [];
    void import('@tauri-apps/api/event').then(({ listen }) => {
      for (const [event, action] of [
        ['tray:restart', 'restart'],
        ['tray:diagnostics', 'diagnostics'],
        ['tray:quit', 'quit'],
      ] as const) {
        void listen<void>(event, () => cb(action)).then((fn) => disposers.push(fn));
      }
    });
    return () => disposers.forEach((d) => d());
  }

  onExistingInstance(cb: () => void): () => void {
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisten = await listen<void>('boot:existing-instance', () => cb());
    });
    return () => unlisten?.();
  }
}

class BrowserBridge implements NativeBridge {
  readonly isDesktop = false;

  private apiBase(): string {
    return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:43120/api/v1';
  }

  /** 浏览器开发模式：端口随 VITE_API_BASE（dev.mjs 传 dev 端口 43130，默认 43120）。 */
  private devInstance(): AppInstance {
    const base = this.apiBase();
    const match = /https?:\/\/127\.0\.0\.1:(\d+)/.exec(base);
    const port = match ? Number(match[1]) : 43120;
    const baseUrl = `http://127.0.0.1:${port}`;
    return {
      instanceId: 'browser-dev',
      pid: 0,
      host: '127.0.0.1',
      port,
      baseUrl,
      apiVersion: 'v1',
      startedAt: new Date().toISOString(),
    };
  }

  async getAppInstance(): Promise<AppInstance | null> {
    return this.devInstance();
  }

  async getHealth(): Promise<Health | null> {
    try {
      const resp = await fetch(`${this.apiBase()}/health`, { signal: AbortSignal.timeout(2000) });
      if (!resp.ok) return null;
      const body = (await resp.json()) as { serviceStatus?: Health };
      return body.serviceStatus ?? null;
    } catch {
      return null;
    }
  }

  async startService(): Promise<BootEvent> {
    const health = await this.getHealth();
    if (health?.ready) {
      return {
        state: 'ready',
        instance: await this.getAppInstance(),
        diagnostics: [],
      };
    }
    return {
      state: 'degraded',
      instance: null,
      diagnostics: [{ key: 'service', message: '本地服务未就绪', detail: '请先启动后端服务' }],
    };
  }

  async stopService(): Promise<void> {
    /* 浏览器开发模式不管理进程 */
  }

  async restartService(): Promise<BootEvent> {
    return this.startService();
  }

  async getDiagnostics(): Promise<DiagnosticItem[]> {
    const health = await this.getHealth();
    if (health?.ready) {
      return [{ key: 'service', message: `本地服务运行中（${health.port}）` }];
    }
    return [{ key: 'service', message: '本地服务未就绪', detail: '浏览器模式需先启动后端服务' }];
  }

  async quit(): Promise<void> {
    /* 浏览器模式忽略 */
  }

  async notify(title: string, body: string): Promise<void> {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') new Notification(title, { body });
      }
    }
  }

  async pickDirectory(): Promise<string | null> {
    return null;
  }

  async openPath(path: string): Promise<void> {
    // 浏览器开发模式：打开本地目录无原生能力，忽略。
    void path;
  }

  onBootState(_cb: (state: BootState) => void): () => void {
    return () => {};
  }

  onTray(_cb: (action: 'restart' | 'diagnostics' | 'quit') => void): () => void {
    return () => {};
  }

  onExistingInstance(_cb: () => void): () => void {
    return () => {};
  }
}

declare global {
  interface Window {
    __TAURI__: {
      event: {
        listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
      };
    };
  }
}