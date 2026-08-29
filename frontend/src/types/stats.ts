import type { Platform } from './room';

export interface StatsTotals {
  recordings: number;
  completed: number;
  failed: number;
  durationMs: number;
  bytes: number;
  successRate: number;
}

export interface StatsByDay {
  date: string;
  recordings: number;
  durationMs: number;
  bytes: number;
}

export interface StatsByPlatform {
  platform: Platform;
  recordings: number;
  durationMs: number;
  bytes: number;
}

export interface RecordingsStats {
  from: string;
  to: string;
  totals: StatsTotals;
  byDay: StatsByDay[];
  byPlatform: StatsByPlatform[];
  generatedAt: string;
}