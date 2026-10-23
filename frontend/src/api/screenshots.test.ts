import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ http: { post: vi.fn() } }));
import { http } from "./client";
import { savePreviewScreenshot } from "./screenshots";
beforeEach(() => vi.mocked(http.post).mockReset());
it.each([undefined, "recording-id"])(
  "uploads original binary PNG through the shared client (recording=%s)",
  async (recordingId) => {
    const png = new Blob(["png bytes"], { type: "image/png" });
    vi.mocked(http.post).mockResolvedValue({
      data: { filePath: "/recordings/截图/image.png" },
    });
    expect(await savePreviewScreenshot("room/id", png, recordingId)).toEqual({
      filePath: "/recordings/截图/image.png",
    });
    expect(http.post).toHaveBeenCalledWith(
      "/rooms/room%2Fid/screenshots",
      png,
      {
        headers: { "Content-Type": "image/png" },
        params: recordingId ? { recordingId } : undefined,
      },
    );
  },
);
