export interface AppInstance {
  instanceId: string;
  pid: number;
  host: string;
  port: number;
  /** 服务根地址，不含 /api/v1（契约：http://127.0.0.1:<port>） */
  baseUrl: string;
  apiVersion: string;
  startedAt: string;
}

export interface Health {
  state?: string;
  version?: string | null;
  uptimeSeconds?: number;
  setupCompleted?: boolean;
  ready?: boolean;
  instanceId?: string;
  apiVersion?: string;
  port?: number;
  baseUrl?: string;
  startedAt?: string;
}

export type DiagnosticStatus = 'ok' | 'warn' | 'error';

export interface DiagnosticItem {
  key: string;
  message: string;
  detail?: string | null;
}

export type BootState = 'booting' | 'ready' | 'existing-instance' | 'degraded' | 'recovery';

export interface BootEvent {
  state: BootState;
  instance?: AppInstance | null;
  diagnostics: DiagnosticItem[];
}

/** 从 AppInstance.baseUrl（服务根地址）拼出 API 前缀。 */
export function apiBaseUrl(instance: AppInstance): string {
  const root = instance.baseUrl.replace(/\/+$/, '');
  return `${root}/api/v1`;
}