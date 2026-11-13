import { http } from "./client";

export function savePreviewScreenshot(
  roomId: string,
  png: Blob,
  recordingId?: string,
): Promise<{ filePath: string }> {
  return saveScreenshot(
    `/rooms/${encodeURIComponent(roomId)}/screenshots`,
    png,
    recordingId,
  );
}

export function saveRecordingScreenshot(
  recordingId: string,
  png: Blob,
): Promise<{ filePath: string }> {
  return saveScreenshot(
    `/recordings/${encodeURIComponent(recordingId)}/screenshots`,
    png,
  );
}

async function saveScreenshot(
  url: string,
  png: Blob,
  recordingId?: string,
): Promise<{ filePath: string }> {
  const { data } = await http.post<{ filePath: string }>(
    url,
    png,
    {
      headers: { "Content-Type": "image/png" },
      params: recordingId ? { recordingId } : undefined,
    },
  );
  return data;
}
