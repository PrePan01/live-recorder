import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePreviewLayout } from "./usePreviewLayout";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
  useRef: (initial: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { current: initial }),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));

const storage = new Map<string, string>();
const write = vi.fn((key: string, value: string) => storage.set(key, value));
const frames = new Map<number, FrameRequestCallback>();
const landscapeKey = "lr-preview-landscape-width";
const portraitKey = "lr-preview-portrait-height";
let target: EventTarget & { innerWidth: number; innerHeight: number };

beforeEach(() => {
  storage.clear();
  write.mockClear();
  frames.clear();
  let frameId = 0;
  target = Object.assign(new EventTarget(), {
    innerWidth: 1200,
    innerHeight: 900,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => 1,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: write },
  });
  vi.stubGlobal("window", target);
});

afterEach(() => vi.unstubAllGlobals());

function renderLayout(defaultWidth?: number) {
  hooks.cursor = 0;
  // React is mocked above so the drag can run without a browser.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  return usePreviewLayout(defaultWidth, null, false);
}

function openLayout(ratio: number, defaultWidth?: number) {
  hooks.slots = [];
  renderLayout(defaultWidth).handleStreamAspectRatio(ratio);
  return renderLayout(defaultWidth);
}

function mouseEvent(type: string, clientX: number, clientY: number, button = 0) {
  return Object.assign(new Event(type), { clientX, clientY, button });
}

function startDrag(layout: ReturnType<typeof renderLayout>, button = 0) {
  layout.onHandleDown(mouseEvent("mousedown", 0, 0, button) as unknown as React.MouseEvent);
}

function flushFrame() {
  const [id, frame] = [...frames][0];
  frames.delete(id);
  frame(0);
}

it("updates layout once per frame and saves only the final size for each orientation", () => {
  const landscape = openLayout(16 / 9);
  expect(landscape.modalWidth).toBe(960);
  startDrag(landscape);
  target.dispatchEvent(mouseEvent("mousemove", -50, 0));
  target.dispatchEvent(mouseEvent("mousemove", -75, 0));
  expect(frames.size).toBe(1);
  expect(renderLayout().modalWidth).toBe(960);
  flushFrame();
  expect(renderLayout().modalWidth).toBe(810);
  expect(write).not.toHaveBeenCalled();

  target.dispatchEvent(mouseEvent("mousemove", -90, 0));
  target.dispatchEvent(mouseEvent("mouseup", -100, 0));
  expect(frames.size).toBe(0);
  expect(write).toHaveBeenCalledExactlyOnceWith(landscapeKey, "760");
  const portrait = openLayout(9 / 16);
  expect(portrait.videoBox.height).toBe(760);
  startDrag(portrait);
  target.dispatchEvent(mouseEvent("mouseup", 100, -105));
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(portraitKey, "550");
  expect(openLayout(16 / 9).modalWidth).toBe(760);
  expect(openLayout(9 / 16).videoBox.height).toBe(550);
  expect(openLayout(16 / 9, 1080).modalWidth).toBe(760);
  expect(openLayout(9 / 16, 1080).videoBox.height).toBe(550);
  renderLayout(1080).handleStreamAspectRatio(16 / 9);
  expect(renderLayout(1080).modalWidth).toBe(760);
});

it("retains defaults for invalid stored sizes and skips clicks and cancelled drags", () => {
  storage.set(landscapeKey, '"800"');
  storage.set(portraitKey, "broken JSON");
  const landscape = openLayout(16 / 9, 1080);
  expect(landscape.modalWidth).toBe(1080);
  startDrag(landscape);
  target.dispatchEvent(mouseEvent("mouseup", 0, 0));
  startDrag(landscape, 2);
  target.dispatchEvent(mouseEvent("mouseup", -100, 0, 2));
  expect(openLayout(9 / 16).videoBox.height).toBe(760);
  startDrag(renderLayout());
  target.dispatchEvent(mouseEvent("mousemove", 0, -100));
  flushFrame();
  expect(renderLayout().videoBox.height).toBe(560);
  target.dispatchEvent(mouseEvent("mousemove", 0, -105));
  target.dispatchEvent(new Event("blur"));
  expect(frames.size).toBe(0);
  expect(renderLayout().videoBox.height).toBe(760);
  expect(write).not.toHaveBeenCalled();
});

it("clamps restored sizes to a smaller viewport without replacing the preferences", () => {
  storage.set(landscapeKey, "1000");
  storage.set(portraitKey, "700");
  target.innerWidth = 700;
  target.innerHeight = 620;
  const landscape = openLayout(16 / 9);
  expect(landscape.modalWidth).toBe(668);
  startDrag(landscape);
  target.dispatchEvent(mouseEvent("mouseup", 50, 0));
  const portrait = openLayout(9 / 16);
  expect(portrait.videoBox.height).toBe(480);
  startDrag(portrait);
  target.dispatchEvent(mouseEvent("mouseup", 0, 50));
  target.innerWidth = 1200;
  target.innerHeight = 900;
  expect(openLayout(16 / 9).modalWidth).toBe(1000);
  expect(openLayout(9 / 16).videoBox.height).toBe(700);
  expect(write).not.toHaveBeenCalled();
});
