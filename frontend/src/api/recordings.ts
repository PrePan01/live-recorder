import { http } from "./client";
import { EndpointResolver } from "./endpoint";
import type { StreamHealth } from "../types/streamHealth";
import type {
  PagedRecordings,
  Recording,
  RecordingQuery,
  RecordingMarker,
} from "../types/recording";

export async function fetchRecordingMarkers(
  id: string,
): Promise<RecordingMarker[]> {
  const { data } = await http.get<{ markers: RecordingMarker[] }>(
    `/recordings/${id}/markers`,
  );
  return data.markers;
}

export async function createRecordingMarker(
  id: string,
  text: string,
  positionSeconds?: number,
): Promise<RecordingMarker> {
  const { data } = await http.post<{ marker: RecordingMarker }>(
    `/recordings/${id}/markers`,
    positionSeconds !== undefined ? { text, positionSeconds } : { text },
  );
  return data.marker;
}

export async function updateRecordingMarker(
  id: string,
  markerId: string,
  patch: { text?: string; positionSeconds?: number },
): Promise<RecordingMarker> {
  const { data } = await http.patch<{ marker: RecordingMarker }>(
    `/recordings/${id}/markers/${markerId}`,
    patch,
  );
  return data.marker;
}

export async function deleteRecordingMarker(
  id: string,
  markerId: string,
): Promise<void> {
  await http.delete(`/recordings/${id}/markers/${markerId}`);
}

export async function exportRecordingClip(
  id: string,
  startSecond: number,
  endSecond: number,
  name: string,
): Promise<{ source: Recording; clip: Recording }> {
  const { data } = await http.post<{ source: Recording; clip: Recording }>(
    `/recordings/${id}/clip-export`,
    { startSecond, endSecond, name },
  );
  return data;
}

/** 流健康快照口（质量灯双读点之一；SSE stream-health 为另一读点）。 */
export async function fetchRecordingQuality(
  id: string,
): Promise<StreamHealth | null> {
  // 契约：路由直接回 StreamHealth 裸对象（非 { quality } 包装）——解包口径勿错。
  const { data } = await http.get<StreamHealth>(`/recordings/${id}/quality`);
  return data ?? null;
}

export async function fetchActiveRecordingHealth(): Promise<StreamHealth[]> {
  const { data } = await http.get<{ health: StreamHealth[] }>(
    "/recordings/quality",
  );
  return data.health;
}

/** 完成态文件播放地址（Range 支持）；必须走 EndpointResolver.base 绝对地址。 */
export function recordingFileUrl(id: string): string {
  return `${EndpointResolver.base}/recordings/${id}/file`;
}

/** 跳播起流地址：GET 流式 fMP4，从目标点前关键帧起切；每次请求即一个新代际。 */
export function recordingSeekStreamUrl(
  id: string,
  startSecond: number,
  streamToken?: string,
): string {
  const url = `${EndpointResolver.base}/recordings/${id}/seek-stream?second=${Math.max(0, Math.floor(startSecond))}`;
  return streamToken
    ? `${url}&snapshot=${encodeURIComponent(streamToken)}`
    : url;
}

/** 跳播预热（pointerdown/提交时）：后端零进程准备（开句柄+查索引）；
 *  返回吸附后的实际起播秒（关键帧级），供 UI 显示真值。 */
export async function prewarmRecordingSeek(
  id: string,
  startSecond: number,
  options: { signal?: AbortSignal; prepareStream?: boolean } = {},
): Promise<{ startSecond?: number; streamToken?: string } | null> {
  const { data } = await http.post<{
    startSecond?: number;
    streamToken?: string;
  } | null>(
    `/recordings/${id}/seek-prewarm`,
    {
      second: Math.max(0, Math.floor(startSecond)),
      prepareStream: options.prepareStream ?? false,
    },
    { signal: options.signal },
  );
  return data ?? null;
}

export async function fetchRecordingGaps(
  id: string,
): Promise<import("../types/recording").RecordingGap[]> {
  const { data } = await http.get<{
    gaps: import("../types/recording").RecordingGap[];
  }>(`/recordings/${id}/gaps`);
  return data.gaps;
}

export async function verifyRecording(id: string): Promise<void> {
  await http.post(`/recordings/${id}/verify`);
}

export async function verifyRecordings(
  ids: string[],
): Promise<{ accepted: number }> {
  const { data } = await http.post<{ accepted: number }>(
    "/recordings/verify-batch",
    { ids },
  );
  return data;
}

export async function fetchRecordings(
  query: RecordingQuery,
): Promise<PagedRecordings> {
  const { data } = await http.get<PagedRecordings>("/recordings", {
    params: query,
  });
  return data;
}

export interface BatchDeleteResult {
  deleted: string[];
  failed: Array<{ id: string; reason: string }>;
}

export async function batchDeleteRecordings(
  ids: string[],
): Promise<BatchDeleteResult> {
  const { data } = await http.post<BatchDeleteResult>(
    "/recordings/batch-delete",
    { ids },
  );
  return data;
}

export async function exportRecordingsCsv(): Promise<string> {
  const res = await http.get("/recordings/export", { responseType: "blob" });
  return (res.data as Blob).text();
}

export async function openRecordingDirectory(id: string): Promise<void> {
  await http.post(`/recordings/${id}/open`);
}

/** 后端按录制 id 查找当前文件，交给系统默认播放器，不读取或下载媒体内容。 */
export async function playRecording(id: string): Promise<void> {
  await http.post(`/recordings/${id}/play`);
}

export async function renameRecording(
  id: string,
  streamTitle: string,
): Promise<Recording> {
  const { data } = await http.patch<{ recording: Recording }>(
    `/recordings/${id}`,
    { streamTitle },
  );
  return data.recording;
}

export async function deleteRecording(id: string): Promise<void> {
  await http.delete(`/recordings/${id}`);
}

/** #220/#221：录制完成后「是否保留」决策。keep=true 保留（恢复管线+上传）；keep=false 不保留（删文件+删记录）。 */
export async function confirmRecordingKeep(
  id: string,
  keep: boolean,
  fileName?: string,
): Promise<Recording | null> {
  const { data } = await http.post<{ recording?: Recording }>(
    `/recordings/${id}/confirm`,
    { keep, ...(keep && fileName ? { fileName } : {}) },
  );
  return data?.recording ?? null;
}
