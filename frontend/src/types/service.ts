export type ServiceState = 'running' | 'restarting';

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface ServiceStatus {
  state: ServiceState;
  version: string | null;
  uptimeSeconds?: number;
  disk: DiskSpace;
  activeRecordings: number;
  setupCompleted: boolean;
}
