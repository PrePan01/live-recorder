import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canCaptureVideoFrame,
  captureVideoFrame,
  MAX_SCREENSHOT_BYTES,
} from "./captureVideoFrame";

afterEach(() => vi.unstubAllGlobals());
function setup(width = 1920, height = 1080) {
  let encoded: BlobCallback = () => {};
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: vi.fn((callback: BlobCallback) => {
      encoded = callback;
    }),
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal("document", { createElement });
  const video = {
    readyState: 2,
    videoWidth: width,
    videoHeight: height,
    seeking: false,
    paused: true,
    currentTime: 10,
  } as HTMLVideoElement;
  return {
    canvas,
    video,
    drawImage,
    createElement,
    encode: (blob: Blob | null) => encoded(blob),
  };
}
describe("captureVideoFrame", () => {
  it.each([
    [1920, 1080],
    [1080, 1920],
  ])(
    "captures the clicked frame at %s × %s before asynchronous encoding",
    async (width, height) => {
      const { canvas, video, drawImage, createElement, encode } = setup(
        width,
        height,
      );
      const pending = captureVideoFrame(video);
      expect(createElement).toHaveBeenCalledWith("canvas");
      expect([canvas.width, canvas.height]).toEqual([width, height]);
      expect(drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0);
      expect(canvas.toBlob).toHaveBeenCalledWith(
        expect.any(Function),
        "image/png",
      );
      video.currentTime = 20;
      const png = new Blob(["png"], { type: "image/png" });
      encode(png);
      expect(await pending).toBe(png);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
    },
  );
  it("accepts paused frames and rejects absent frames, seeking and media errors", () => {
    const { video } = setup();
    expect(canCaptureVideoFrame(video)).toBe(true);
    expect(canCaptureVideoFrame(null)).toBe(false);
    for (const patch of [
      { readyState: 1 },
      { videoWidth: 0 },
      { videoHeight: 0 },
      { seeking: true },
      { error: {} },
    ]) {
      const unavailable = { ...video, ...patch } as HTMLVideoElement;
      expect(canCaptureVideoFrame(unavailable)).toBe(false);
      expect(() => captureVideoFrame(unavailable)).toThrow(
        "当前没有可截取的画面",
      );
    }
  });
  it.each(["null", "oversized", "wrong type", "throw"] as const)(
    "reports encoding failure (%s) and releases canvas memory",
    async (kind) => {
      const { canvas, video, encode } = setup();
      if (kind === "throw")
        canvas.toBlob.mockImplementation(() => {
          throw new Error("encode failed");
        });
      const pending = captureVideoFrame(video);
      if (kind === "null") encode(null);
      if (kind === "oversized")
        encode({ size: MAX_SCREENSHOT_BYTES + 1, type: "image/png" } as Blob);
      if (kind === "wrong type")
        encode(new Blob(["x"], { type: "image/jpeg" }));
      await expect(pending).rejects.toThrow(
        kind === "oversized" ? "32 MiB" : "截图编码失败",
      );
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
    },
  );
  it("reports canvas capture errors", () => {
    const { video, drawImage, canvas } = setup();
    drawImage.mockImplementation(() => {
      throw new Error("security");
    });
    expect(() => captureVideoFrame(video)).toThrow("截图失败");
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
});
