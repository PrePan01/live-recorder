import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: { success: h.success, error: h.error } }) },
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => (h.slots[h.cursor++] ??= { current: value }),
  useState: (value: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = value;
    return [
      h.slots[i],
      (next: unknown) => {
        h.slots[i] = next;
      },
    ];
  },
  useEffect: (fn: () => () => void, deps: unknown[]) => {
    const i = h.cursor++;
    const old = h.slots[i] as
      { deps: unknown[]; cleanup: () => void } | undefined;
    if (!old || deps.some((dep, index) => !Object.is(dep, old.deps[index])))
      h.effects.push(() => {
        old?.cleanup();
        h.slots[i] = { deps, cleanup: fn() };
      });
  },
}));
vi.mock("../../api/screenshots", () => ({ savePreviewScreenshot: vi.fn() }));
vi.mock("../../utils/captureVideoFrame", () => ({
  canCaptureVideoFrame: (video: HTMLVideoElement | null) =>
    Boolean(video && !video.seeking),
  captureVideoFrame: vi.fn(),
}));
import { savePreviewScreenshot } from "../../api/screenshots";
import { captureVideoFrame } from "../../utils/captureVideoFrame";
import { usePreviewScreenshot } from "./usePreviewScreenshot";
const video = Object.assign(new EventTarget(), {
  seeking: false,
}) as unknown as HTMLVideoElement;
function render(ready = true, switching = false, recordingId?: string) {
  h.cursor = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  const value = usePreviewScreenshot(
    "room",
    video,
    ready,
    switching,
    recordingId,
  );
  h.effects.splice(0).forEach((fn) => fn());
  return value;
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.success.mockReset();
  h.error.mockReset();
  vi.mocked(captureVideoFrame)
    .mockReset()
    .mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  vi.mocked(savePreviewScreenshot)
    .mockReset()
    .mockResolvedValue({ filePath: "/recordings/截图/image.png" });
  Object.assign(video, { seeking: false });
});
afterEach(() => {
  for (const slot of h.slots)
    (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
});
describe("usePreviewScreenshot", () => {
  it("saves once during rapid repeated clicks, shows loading and toasts only after saving", async () => {
    let finish = (_value: { filePath: string }) => {};
    vi.mocked(savePreviewScreenshot).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render();
    const ui = render(true, false, "recording");
    const pending = ui.takeScreenshot();
    await ui.takeScreenshot();
    await Promise.resolve();
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
    expect(savePreviewScreenshot).toHaveBeenCalledWith(
      "room",
      expect.any(Blob),
      "recording",
    );
    expect(render().saving).toBe(true);
    expect(h.success).not.toHaveBeenCalled();
    finish({ filePath: "/recordings/截图/image.png" });
    await pending;
    expect(h.success).toHaveBeenCalledWith(
      "截图已保存：/recordings/截图/image.png",
    );
    expect(render().saving).toBe(false);
  });
  it("supports preview without recording and prevents capture during source switches or native seeking", async () => {
    render();
    expect(render().enabled).toBe(true);
    video.dispatchEvent(new Event("waiting"));
    expect(render().enabled).toBe(false);
    video.dispatchEvent(new Event("canplay"));
    expect(render().enabled).toBe(true);
    await render(false).takeScreenshot();
    await render(true, true).takeScreenshot();
    Object.assign(video, { seeking: true });
    video.dispatchEvent(new Event("seeking"));
    expect(render().enabled).toBe(false);
    expect(captureVideoFrame).not.toHaveBeenCalled();
    Object.assign(video, { seeking: false });
    video.dispatchEvent(new Event("seeked"));
    await render().takeScreenshot();
    expect(savePreviewScreenshot).toHaveBeenCalledWith(
      "room",
      expect.any(Blob),
      undefined,
    );
  });
  it.each(["capture", "save"])(
    "shows specific %s errors and allows retry",
    async (stage) => {
      if (stage === "capture")
        vi.mocked(captureVideoFrame).mockImplementationOnce(() => {
          throw new Error("编码失败");
        });
      else
        vi.mocked(savePreviewScreenshot).mockRejectedValueOnce(
          new Error("磁盘空间不足"),
        );
      render();
      await render().takeScreenshot();
      expect(h.error).toHaveBeenCalledWith(
        stage === "capture" ? "编码失败" : "磁盘空间不足",
      );
      expect(h.success).not.toHaveBeenCalled();
      await render().takeScreenshot();
      expect(h.success).toHaveBeenCalledTimes(1);
    },
  );
});
