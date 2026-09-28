import type { Settings } from './settings';
import type { Room } from './room';
import type { Alert } from './alert';

/** v1.4：目录树浏览响应 */
export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface BrowseDirectoriesResult {
  ok: boolean;
  path: string;
  parent: string | null;
  directories: DirectoryEntry[];
}

/** 开播预测数据的导出形态：按 platform+url 归属，导入时映射到本地直播间。 */
export interface PredictionArchiveRoom {
  platform: string;
  url: string;
  events: Array<{ id: string; detectedAt: string; source: string; lowerBoundAt: string | null; platformStartedAt: string | null }>;
  forecasts: Array<{
    targetDate: string;
    probability: string;
    generatedAt: string;
    outcome: string | null;
    resolvedAt: string | null;
    rawProbability: string | null;
    windowStartAt: string | null;
    windowEndAt: string | null;
  }>;
  coverage: Array<{ targetDate: string; firstCheckedAt: string; lastCheckedAt: string; checks: number }>;
  intervals: Array<{ startAt: string; endAt: string }>;
  recordingSessions: Array<{ startedAt: string; streamSessionId: string | null }>;
}

export interface PredictionImportSummary {
  matchedRooms: number;
  skippedRooms: number;
  events: number;
  forecasts: number;
  coverage: number;
  intervals: number;
  recordingSessions: number;
}

export interface RecordingArchiveEntry {
  id: string;
  startedAt: string;
  endedAt: string | null;
  streamSessionId: string | null;
  streamTitle: string;
  roomName: string;
  state: 'completed' | 'failed';
  fileSizeBytes: number;
  retryCount: number;
  quality: string | null;
  integrity: string | null;
  createdAt: string;
}

export interface RecordingArchive {
  rooms: Array<{ platform: string; url: string; recordings: RecordingArchiveEntry[] }>;
}

/** v1.4：配置导出 */
export interface ExportConfig {
  version: 1;
  exportedAt: string;
  settings: Settings;
  rooms: Room[];
  alerts: Alert[];
  recordings: RecordingArchive;
  prediction: { rooms: PredictionArchiveRoom[] };
}

/** v1.4：导出到用户选定路径的结果（reason 为 no-dialog 时需前端兜底下载） */
export interface ExportConfigFileResult {
  ok: boolean;
  saved: boolean;
  path: string | null;
  reason: 'cancelled' | 'no-dialog' | null;
}

/** v1.4：配置导入输入（settings 为完整视图，密钥值不导入） */
export interface ImportConfigInput {
  version?: number;
  settings?: Partial<Settings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean }>;
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
  recordings?: RecordingArchive;
}

export interface ImportResult {
  ok: boolean;
  appliedSettings: boolean;
  importedRooms: number;
  skippedRooms: number;
  importedAlerts: number;
  /** 旧备份没有录制历史时为 null。 */
  recordings: { matchedRooms: number; skippedRooms: number; recordings: number } | null;
  /** 文件里没有开播预测数据时为 null。 */
  prediction: PredictionImportSummary | null;
}
