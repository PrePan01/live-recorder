import { describe, expect, it, vi, afterEach } from "vitest";
import { holdVideoFrame, releaseVideoFrame, waitForVideoFrame } from "./videoFrameTransition";

afterEach(() => vi.unstubAllGlobals());

describe("切流画面衔接", () => {
  it("按原始分辨率保留一帧，连续切流不覆盖已保留的画面", () => {
    const drawImage = vi.fn();
    const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    const canvas = { style: { display: "none" }, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    holdVideoFrame(video, canvas);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    expect(canvas.style.display).toBe("block");
    holdVideoFrame(video, canvas);
    expect(drawImage).toHaveBeenCalledTimes(1);
    releaseVideoFrame(canvas);
    expect(canvas.style.display).toBe("none");
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it("没有解码画面或复制失败时允许切流，不显示空遮罩", () => {
    const drawImage = vi.fn(() => { throw new Error("unavailable"); });
    const video = { readyState: 0, videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    const canvas = { style: { display: "none" }, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    holdVideoFrame(video, canvas);
    expect(drawImage).not.toHaveBeenCalled();
    Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
    expect(() => holdVideoFrame(video, canvas)).not.toThrow();
    expect(canvas.style.display).toBe("none");
  });

  it("等视频帧呈现后才揭开画面，取消后的迟到帧不能串代", () => {
    let callback = () => {};
    const cancelVideoFrameCallback = vi.fn();
    const video = {
      requestVideoFrameCallback: (next: () => void) => { callback = next; return 7; },
      cancelVideoFrameCallback,
    } as unknown as HTMLVideoElement;
    const onFrame = vi.fn();
    const cancel = waitForVideoFrame(video, onFrame, () => true);
    expect(onFrame).not.toHaveBeenCalled();
    callback();
    expect(onFrame).toHaveBeenCalledTimes(1);
    cancel();
    expect(cancelVideoFrameCallback).toHaveBeenCalledWith(7);
    callback();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("旧源视频帧不能揭开新源的遮罩", () => {
    let callback = () => {};
    const video = {
      requestVideoFrameCallback: (next: () => void) => { callback = next; return 1; },
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    const onFrame = vi.fn();
    let current = true;
    const cancel = waitForVideoFrame(video, onFrame, () => current);
    current = false;
    callback();
    expect(onFrame).not.toHaveBeenCalled();
    cancel();
  });

  it("旧内核在定位完成且画面就绪后等待完整绘制周期", () => {
    let callback = () => {};
    vi.stubGlobal("requestAnimationFrame", (next: () => void) => { callback = next; return 3; });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const video = { readyState: 1, seeking: true } as HTMLVideoElement;
    const onFrame = vi.fn();
    const cancel = waitForVideoFrame(video, onFrame, () => true);
    callback();
    expect(onFrame).not.toHaveBeenCalled();
    Object.assign(video, { readyState: 2, seeking: false });
    callback();
    expect(onFrame).not.toHaveBeenCalled();
    callback();
    expect(onFrame).toHaveBeenCalledTimes(1);
    cancel();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(3);
  });
});
