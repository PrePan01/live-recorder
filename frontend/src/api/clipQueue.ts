import { http } from "./client";
import type { ClipQueueItem } from "../types/clipQueue";
export async function listClipQueue(
  recordingId?: string,
  page = 1,
): Promise<{ items: ClipQueueItem[]; hasMore: boolean }> {
  const { data } = await http.get<{ items: ClipQueueItem[]; hasMore: boolean }>(
    "/clip-queue",
    { params: { recordingId, page } },
  );
  return data;
}
export async function exportClipSegments(
  recordingId: string,
  markerIds: string[],
  requestId: string,
): Promise<string> {
  const { data } = await http.post<{ batchId: string }>(
    "/clip-queue/export-all",
    { recordingId, markerIds, requestId },
  );
  return data.batchId;
}
export async function exportClipRange(recordingId: string, startSecond: number, endSecond: number, name: string, requestId: string): Promise<string> {
  const { data } = await http.post<{ batchId: string }>("/clip-queue/export-range", {
    recordingId, startSecond, endSecond, name, requestId,
  });
  return data.batchId;
}
export async function cancelClipQueueItem(id: string): Promise<void> {
  await http.post(`/clip-queue/${id}/cancel`, {});
}
export async function retryClipQueueItem(id: string): Promise<void> {
  await http.post(`/clip-queue/${id}/retry`, {});
}
export async function cancelPendingClipQueue(batchId: string): Promise<void> {
  await http.post("/clip-queue/cancel-pending", { batchId });
}
