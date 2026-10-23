import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingMediaClockMemory, useRecordingMediaRange } from "./useRecordingMediaRange";
import { fetchRecordingPosition } from "../api/recordings";
const hooks = vi.hoisted(() => ({ value: null as unknown, effect: undefined as undefined | (() => (() => void) | undefined), effects: [] as Array<() => void> }));
vi.mock("react", () => ({
  useState: () => [hooks.value, (value: unknown) => {
    hooks.value = typeof value === "function" ? value(hooks.value) : value;
  }],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: NonNullable<typeof hooks.effect>) => { hooks.effect = effect; hooks.effects.push(effect); },
}));
vi.mock("../api/recordings", () => ({ fetchRecordingPosition: vi.fn() }));
let cleanup: (() => void) | undefined;
const snapshot = (durationSeconds: number) => ({ durationSeconds, positionSeconds: durationSeconds, previewOffsetSeconds: -45 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  hooks.value = null; hooks.effect = undefined; hooks.effects = []; cleanup = undefined;
  recordingMediaClockMemory.clear();
  vi.mocked(fetchRecordingPosition).mockReset();
});
afterEach(() => { cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start(id = "rec", smooth = false) {
  // React is mocked above; this helper runs the captured effect explicitly.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  useRecordingMediaRange(id, null, smooth);
  cleanup = hooks.effect?.();
  await Promise.resolve();
}
describe("recording file clock", () => {
  it("does not rewind the committed recording clock when reopening preview between batches", async () => {
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(20));
    await start("rec", true);
    await vi.advanceTimersByTimeAsync(3000);
    hooks.effects = [];
    const beforeClose = useRecordingMediaRange("rec", null, true).durationSeconds;
    hooks.effects[0](); // Commit the displayed time, as React does after render.
    cleanup?.();
    hooks.value = null; // A different modal instance mounts for the same recording.
    await start("rec", true);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(beforeClose);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(beforeClose + 1);
  });
  it("keeps the shared button/track clock advancing while preview has no playable frames", async () => {
    let received = 20;
    vi.mocked(fetchRecordingPosition).mockImplementation(async () => snapshot(received));
    const video = { readyState: 0, currentTime: 0,
      addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLVideoElement;
    useRecordingMediaRange("rec", video, true);
    cleanup = hooks.effect?.();
    await Promise.resolve();
    const initial = useRecordingMediaRange("rec", video, true).durationSeconds;
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(received);
    // Reproduce opening a modal between HLS batches. API responses succeed but
    // keep the same tail; no loadeddata event or new media is needed to tick.
    for (let second = 1; second <= 3; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(useRecordingMediaRange("rec", video, true).durationSeconds).toBe(initial + second);
      expect(video.readyState).toBe(0);
    }
    received = 25;
    for (let second = 4; second <= 8; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(useRecordingMediaRange("rec", video, true).durationSeconds).toBe(initial + second);
      expect(video.readyState).toBe(0);
    }
    expect(fetchRecordingPosition).toHaveBeenCalledTimes(9);
    // A preview element replacement must not reset the recording clock.
    cleanup?.();
    useRecordingMediaRange("rec", null, true);
    cleanup = hooks.effect?.();
    await Promise.resolve();
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(initial + 8);
    received = 30;
    await vi.advanceTimersByTimeAsync(2000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(initial + 10);
    // Exhausting confirmed media during a genuine upstream stall still freezes
    // both displays; stopping exposes the complete confirmed duration.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(30);
    expect(useRecordingMediaRange("rec", null, false).durationSeconds).toBe(30);
  });
  it("plays burst-delivered YouTube media at one second per second without exceeding the received tail", async () => {
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(0));
    await start("rec", true);
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(5));
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(0);
    for (let second = 1; second <= 5; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(second);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(5);
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(10));
    await vi.advanceTimersByTimeAsync(2000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(6);
    // On stop, show the final received duration rather than leaving a lagging counter.
    expect(useRecordingMediaRange("rec", null, false).durationSeconds).toBe(10);
  });
  it("freezes smoothing on a hidden tab and keeps markers and the visible track on the same clock", async () => {
    vi.mocked(fetchRecordingPosition).mockResolvedValue(snapshot(20));
    await start("rec", true);
    const initial = useRecordingMediaRange("rec", null, true).durationSeconds;
    useRecordingMediaRange("rec", null, true).update(snapshot(25));
    Object.assign(document, { hidden: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(initial);
    Object.assign(document, { hidden: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(useRecordingMediaRange("rec", null, true).durationSeconds).toBe(initial + 1);
    expect(useRecordingMediaRange("new", null, true).durationSeconds).toBe(0);
  });
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
