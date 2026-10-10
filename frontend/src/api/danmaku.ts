import { http } from './client';
import type { DanmakuGap, DanmakuMessage, DanmakuStatus } from '../types/danmaku';

/** 拉取某录制在媒体时间区间内的弹幕（时间轴查询默认不含 unmappable）。 */
export async function fetchDanmaku(
  recordingId: string,
  opts: { fromMs?: number; toMs?: number; limit?: number; includeUnmappable?: boolean; cursor?: string; signal?: AbortSignal } = {},
): Promise<{ messages: DanmakuMessage[]; gaps: DanmakuGap[]; next?: string | null; mediaNowMs?: number | null; status?: DanmakuStatus }> {
  const params = new URLSearchParams();
  if (opts.fromMs != null) params.set('fromMs', String(Math.max(0, Math.floor(opts.fromMs))));
  if (opts.toMs != null) params.set('toMs', String(Math.max(0, Math.floor(opts.toMs))));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.includeUnmappable) params.set('includeUnmappable', '1');
  if (opts.cursor != null) params.set("cursor", opts.cursor);
  const query = params.toString();
  const { data } = await http.get<{
    messages: DanmakuMessage[];
    gaps: DanmakuGap[];
    next?: string | null; mediaNowMs?: number | null;
    status?: DanmakuStatus;
  }>(`/recordings/${recordingId}/danmaku${query ? `?${query}` : ''}`, { signal: opts.signal });
  return data;
}

/** 导出整段录像的 ASS 滚动弹幕和 SRT 文字字幕。 */
export async function exportDanmaku(
  recordingId: string,
  options: { directory: string; durationMs: number; width: number; height: number; opacity: number; density: number },
): Promise<{ assPath: string; srtPath: string; count: number; assCount: number }> {
  const { data } = await http.post(`/recordings/${recordingId}/danmaku-export`, options, { timeout: 0 });
  return data;
}

export interface LiveDanmakuSnapshot {
  messages: DanmakuMessage[];
  cursor: number;
  generation: string;
  mediaNowMs: number;
  status: DanmakuStatus;
}
const previewPath = (roomId: string, token: string) => `/rooms/${encodeURIComponent(roomId)}/danmaku-preview/${encodeURIComponent(token)}`;
export async function subscribeLiveDanmaku(roomId: string, token: string, signal: AbortSignal): Promise<LiveDanmakuSnapshot> {
  const { data } = await http.post<LiveDanmakuSnapshot>(previewPath(roomId, token), undefined, { signal });
  return data;
}
export async function readLiveDanmaku(roomId: string, token: string, cursor: number, signal: AbortSignal): Promise<LiveDanmakuSnapshot> {
  const { data } = await http.get<LiveDanmakuSnapshot>(previewPath(roomId, token), { params: { cursor }, signal });
  return data;
}
export async function unsubscribeLiveDanmaku(roomId: string, token: string): Promise<void> {
  await http.delete(previewPath(roomId, token), { timeout: 3000 });
}
