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

export interface StatsByRoom {
  roomId: string;
  /** recordings.room_name 快照：房间已删除/改名时的兜底名称（评审稿 v2 图3 口径） */
  roomName: string;
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
  /** 可选：BE Phase1（task #52）合入后返回；旧后端/缓存缺失时前端走空态 */
  byRoom?: StatsByRoom[];
  generatedAt: string;
}