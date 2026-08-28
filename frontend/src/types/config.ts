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

/** v1.4：配置导出 */
export interface ExportConfig {
  version: 1;
  exportedAt: string;
  settings: Settings;
  rooms: Room[];
  alerts: Alert[];
}

/** v1.4：配置导入输入（settings 为完整视图，密钥值不导入） */
export interface ImportConfigInput {
  version?: number;
  settings?: Partial<Settings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean }>;
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
}

export interface ImportResult {
  ok: boolean;
  appliedSettings: boolean;
  importedRooms: number;
  skippedRooms: number;
  importedAlerts: number;
}