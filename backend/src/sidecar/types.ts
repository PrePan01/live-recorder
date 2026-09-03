export const APP_VERSION = '0.5.77';
export const API_VERSION = 'v1' as const;
export const DEFAULT_HOST = '127.0.0.1';

export interface AppInstance {
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  baseUrl: string;
  apiVersion: typeof API_VERSION;
  startedAt: string;
}