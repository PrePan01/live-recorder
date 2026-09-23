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
  /** 保存目录是否可用（未配置/不存在/不可写 = false）；不含磁盘空间语义。旧后端无此字段。 */
  directoryAvailable?: boolean;
}
