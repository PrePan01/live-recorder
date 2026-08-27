export type ServiceHealth = 'online' | 'offline' | 'restarting';

export interface DiskSpace {
  path: string;
  free: number;
  total: number;
}

export interface ServiceStatus {
  status: ServiceHealth;
  version: string | null;
  diskSpace: DiskSpace;
  activeRecordings: number;
  setupCompleted: boolean;
}
