import type { Settings } from "./settings";
import type { Room } from "./room";
import type { Alert } from "./alert";
import type { Tag } from "./tag";

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

export interface PredictionArchiveRoom {
  platform: string;
  url: string;
  events: Array<{
    id: string;
    detectedAt: string;
    source: string;
    lowerBoundAt: string | null;
    platformStartedAt: string | null;
  }>;
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
  coverage: Array<{
    targetDate: string;
    firstCheckedAt: string;
    lastCheckedAt: string;
    checks: number;
  }>;
  intervals: Array<{ startAt: string; endAt: string }>;
  recordingSessions: Array<{
    startedAt: string;
    streamSessionId: string | null;
  }>;
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
  state: "completed" | "failed";
  fileSizeBytes: number;
  retryCount: number;
  quality: string | null;
  integrity: string | null;
  createdAt: string;
}

export interface RecordingArchive {
  rooms: Array<{
    platform: string;
    url: string;
    recordings: RecordingArchiveEntry[];
  }>;
}

export interface ClientAppearanceConfig {
  showStatusBarAlerts?: boolean;
  showLiveRoomCover?: boolean;
}

export interface ExportConfig {
  version: 1;
  exportedAt: string;
  appearance?: ClientAppearanceConfig;
  settings: Settings;
  rooms: Room[];
  tags: Tag[];
  alerts: Alert[];
  recordings: RecordingArchive;
  prediction: { rooms: PredictionArchiveRoom[] };
}

export interface ExportConfigFileResult {
  ok: boolean;
  saved: boolean;
  path: string | null;
  reason: "cancelled" | "no-dialog" | null;
}

export interface ImportConfigInput {
  version?: number;
  appearance?: ClientAppearanceConfig;
  settings?: Partial<Settings>;
  rooms?: Array<{
    platform: string;
    url: string;
    displayName?: string;
    enabled?: boolean;
    tags?: Array<{ name: string; color?: string }>;
  }>;
  tags?: Array<{ name: string; color?: string }>;
  alerts?: Array<{
    level: string;
    source: string;
    message: string;
    occurredAt: string;
    resolved?: boolean;
  }>;
  recordings?: RecordingArchive;
}

export interface ImportResult {
  ok: boolean;
  appliedSettings: boolean;
  importedRooms: number;
  skippedRooms: number;
  importedAlerts: number;
  recordings: {
    matchedRooms: number;
    skippedRooms: number;
    recordings: number;
  } | null;
  prediction: PredictionImportSummary | null;
}
