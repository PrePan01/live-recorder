import { http } from './client';
import type { RecordingsStats } from '../types/stats';

export interface StatsQuery {
  from?: string;
  to?: string;
  platform?: string;
  tagId?: string;
  roomId?: string;
}

export async function fetchRecordingsStats(q: StatsQuery = {}): Promise<RecordingsStats> {
  const { data } = await http.get<RecordingsStats>('/stats/recordings', { params: q });
  return data;
}