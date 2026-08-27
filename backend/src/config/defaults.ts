import type { CheckIntervalSec, DiskGuardConfig, RetryConfig } from '../types/settings.js';

export const SERVICE_PORT = 43120;
export const SERVICE_HOST = '127.0.0.1';
export const API_BASE_PATH = '/api/v1';

export const DEFAULT_CHECK_INTERVAL: CheckIntervalSec = {
  default: 60,
  bilibili: 60,
  douyin: 120,
};

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  delaysSeconds: [5, 15, 45],
};

export const DEFAULT_DISK_GUARD: DiskGuardConfig = {
  minFreeBytes: 21_474_836_480, // 20 GiB
  minFreePercent: 10,
};

export const DEFAULT_SETTINGS = {
  recordingDirectory: '',
  maxConcurrentRecordings: 2,
  checkIntervalSec: DEFAULT_CHECK_INTERVAL,
  retry: DEFAULT_RETRY,
  diskGuard: DEFAULT_DISK_GUARD,
  mail: {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    username: '',
    from: '',
    recipients: [] as string[],
  },
  dedupeWindowMinutes: 30,
};
