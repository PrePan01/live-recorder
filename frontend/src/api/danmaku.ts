import { http } from './client';
import type { DanmakuGap, DanmakuMessage, DanmakuStatus } from '../types/danmaku';

/** 拉取某录制在媒体时间区间内的弹幕（时间轴查询默认不含 unmappable）。 */
export async function fetchDanmaku(
  recordingId: string,
  opts: { fromMs?: number; toMs?: number; limit?: number; includeUnmappable?: boolean } = {},
): Promise<{ messages: DanmakuMessage[]; gaps: DanmakuGap[]; next?: string; status?: DanmakuStatus }> {
  const params = new URLSearchParams();
  if (opts.fromMs != null) params.set('fromMs', String(Math.max(0, Math.floor(opts.fromMs))));
  if (opts.toMs != null) params.set('toMs', String(Math.max(0, Math.floor(opts.toMs))));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.includeUnmappable) params.set('includeUnmappable', '1');
  const query = params.toString();
  const { data } = await http.get<{
    messages: DanmakuMessage[];
    gaps: DanmakuGap[];
    next?: string;
    status?: DanmakuStatus;
  }>(`/recordings/${recordingId}/danmaku${query ? `?${query}` : ''}`);
  return data;
}
