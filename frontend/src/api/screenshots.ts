import { http } from "./client";

export async function savePreviewScreenshot(
  roomId: string,
  png: Blob,
  recordingId?: string,
): Promise<{ filePath: string }> {
  const { data } = await http.post<{ filePath: string }>(
    `/rooms/${encodeURIComponent(roomId)}/screenshots`,
    png,
    {
      headers: { "Content-Type": "image/png" },
      params: recordingId ? { recordingId } : undefined,
    },
  );
  return data;
}
