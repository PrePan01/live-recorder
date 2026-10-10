import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingMediaRange } from "./useRecordingMediaRange";
import { fetchRecordingPosition } from "../api/recordings";
const hooks = vi.hoisted(() => ({ value: null as unknown, effect: undefined as undefined | (() => (() => void) | undefined) }));
vi.mock("react", () => ({
  useState: () => [hooks.value, (value: unknown) => {
    hooks.value = typeof value === "function" ? value(hooks.value) : value;
  }],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: typeof hooks.effect) => { hooks.effect = effect; },
}));
vi.mock("../api/recordings", () => ({ fetchRecordingPosition: vi.fn() }));
let cleanup: (() => void) | undefined;
const snapshot = (durationSeconds: number) => ({ durationSeconds, positionSeconds: durationSeconds, previewOffsetSeconds: -45 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  hooks.value = null; hooks.effect = undefined; cleanup = undefined;
  vi.mocked(fetchRecordingPosition).mockReset();
});
afterEach(() => { cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start(id = "rec") {
  // React is mocked above; this helper runs the captured effect explicitly.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  useRecordingMediaRange(id, null);
  cleanup = hooks.effect?.();
  await Promise.resolve();
}
describe("recording file clock", () => {
  it("starts at zero while unknown, then includes the cached GOP without a wall-clock fallback", async () => {
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(0);
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(3.125));
    await start();
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(3.125);
    await vi.advanceTimersByTimeAsync(5000);
    // Received media has not advanced: recording and track must remain at 3s.
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(3.125);
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(7.25));
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(7.25);
  });
  it("retains the file position through a failed request and accepts the resumed media clock", async () => {
    vi.mocked(fetchRecordingPosition).mockResolvedValueOnce(snapshot(46.25)).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snapshot(47.5));
    await start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(46.25);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(47.5);
  });
  it("does not carry the previous recording clock to a new recording or accept disposed requests", async () => {
    let resolve!: (data: ReturnType<typeof snapshot>) => void;
    vi.mocked(fetchRecordingPosition).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    cleanup?.(); cleanup = undefined;
    expect(useRecordingMediaRange("new", null).durationSeconds).toBe(0);
    resolve(snapshot(99)); await Promise.resolve();
    expect(useRecordingMediaRange("new", null).durationSeconds).toBe(0);
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(0);
  });
  it("shares a fresh click-time response with the counter and track while keeping recording identities separate", async () => {
    const range = useRecordingMediaRange("rec", null);
    range.update(snapshot(49.125));
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(49.125);
    expect(useRecordingMediaRange("other", null).durationSeconds).toBe(0);
  });
  it("does not let a delayed periodic response rewind a fresher click-time snapshot", async () => {
    let resolve!: (data: ReturnType<typeof snapshot>) => void;
    vi.mocked(fetchRecordingPosition).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await start();
    useRecordingMediaRange("rec", null).update(snapshot(50.125));
    resolve(snapshot(49)); await Promise.resolve();
    expect(useRecordingMediaRange("rec", null).durationSeconds).toBe(50.125);
  });
});
