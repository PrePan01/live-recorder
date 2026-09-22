import { http } from './client';
import type { RecordingsStats } from '../types/stats';

export interface StatsQuery {
  from?: string;
  to?: string;
  platform?: string;
  tagId?: string;
  roomId?: string;
}

export async function fetchRecordingsStats(
  q: StatsQuery = {},
  opts?: { signal?: AbortSignal },
): Promise<RecordingsStats> {
  const { data } = await http.get<RecordingsStats>('/stats/recordings', {
    params: q,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  return data;
}