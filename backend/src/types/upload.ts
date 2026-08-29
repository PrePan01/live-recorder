export type UploadJobStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';

export interface UploadJob {
  id: string;
  recordingId: string;
  status: UploadJobStatus;
  progress: number;
  remotePath: string | null;
  error: string | null;
  retryCount: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

/** V5 OpenList 上传配置（令牌经 SecretStore，不落盘、不回显）。 */
export interface OpenListConfig {
  enabled: boolean;
  serverUrl: string;
  directoryTemplate: string;
  username: string;
  /** 派生标记：令牌是否已配置（SecretStore 存在键）。 */
  hasToken: boolean;
}