import { describe, expect, it, vi } from "vitest";
import { useRecordingMediaPosition } from "./useRecordingMediaPosition";
import { resetPreviewMediaClock, setLiveMediaOrigin } from "../utils/previewMediaClock";
vi.mock("react", () => ({
  useState: () => [8, vi.fn()],
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
}));
function clock(durationSeconds = 10.125) {
  return { durationSeconds, previewOffsetSeconds: -45, update: vi.fn() };
}
function video() {
  return { currentTime: 8.125, readyState: 2, buffered: { length: 1, start: () => 0, end: () => 12 } } as unknown as HTMLVideoElement;
}
describe("marker positions follow the visible live track or the historical playhead", () => {
  it("saves 00:10 when the live track shows 00:10 and buffered video is at 00:08", async () => {
    const media = video();
    setLiveMediaOrigin(media, 0);
    const position = useRecordingMediaPosition("rec", media, { mode: "live" }, null, clock());
    expect(position.current).toBe(10.125);
    expect(await position.getPosition()).toBe(10.125);
  });
  it("keeps the click point while the recording and video advance before saving", async () => {
    const media = video();
    const range = clock();
    const position = useRecordingMediaPosition("rec", media, { mode: "live" }, null, range);
    const captured = position.getPosition();
    range.durationSeconds = 18;
    media.currentTime = 16;
    expect(await captured).toBe(10.125);
    expect(range.update).not.toHaveBeenCalled();
  });
  it("uses the recording's displayed clock even when preview was opened earlier", async () => {
    const media = video();
    setLiveMediaOrigin(media, 45000);
    const position = useRecordingMediaPosition("rec", media, { mode: "live" }, null, clock(3.125));
    expect(position.current).toBe(3.125);
    expect(await position.getPosition()).toBe(3.125);
  });
  it("captures both segment endpoints from their respective clicks with fractions preserved", async () => {
    const media = video();
    const start = useRecordingMediaPosition("rec", media, { mode: "live" }, null, clock(10.125)).getPosition();
    media.currentTime = 12.25;
    const end = useRecordingMediaPosition("rec", media, { mode: "live" }, null, clock(14.25)).getPosition();
    expect(await start).toBe(10.125);
    expect(await end).toBe(14.25);
  });
  it("reads the fresh video playhead after a backward historical seek, ignoring the live tail", async () => {
    const media = video();
    resetPreviewMediaClock(media);
    const position = useRecordingMediaPosition("rec", media, { mode: "history", second: 8 }, { recordingId: "rec", startSecond: 30, generation: 1 }, clock(93), { current: 1 });
    expect(await position.getPosition()).toBe(38.125);
    media.currentTime = 2.25;
    expect(await position.getPosition()).toBe(32.25);
  });
  it("rejects old frames after a failed seek until the requested generation presents a frame", async () => {
    const frameGeneration = { current: 1 };
    const position = useRecordingMediaPosition("rec", video(), { mode: "history", loading: false },
      { recordingId: "rec", startSecond: 40, generation: 2 }, clock(93), frameGeneration);
    expect(position.current).toBeUndefined();
    await expect(position.getPosition()).rejects.toThrow("尚未就绪");
    frameGeneration.current = 2;
    expect(await position.getPosition()).toBe(48.125);
  });
  it("rejects a previous recording's playable seek source during recording switches", async () => {
    const position = useRecordingMediaPosition("new-rec", video(), { mode: "history" },
      { recordingId: "rec", startSecond: 0, generation: 1 }, clock(3), { current: 1 });
    expect(position.current).toBeUndefined();
    await expect(position.getPosition()).rejects.toThrow("尚未就绪");
  });
  it("uses the cumulative recording clock after reconnecting rather than the new preview's zero", async () => {
    const position = useRecordingMediaPosition("rec", video(), { mode: "live" }, null, clock(2510.125));
    expect(await position.getPosition()).toBe(2510.125);
  });
  it("rejects a native seek that still has old playable data until seeking completes", async () => {
    const media = video();
    Object.defineProperty(media, "seeking", { value: true, writable: true });
    const position = useRecordingMediaPosition("rec", media, { mode: "history" },
      { recordingId: "rec", startSecond: 30, generation: 1 }, clock(93), { current: 1 });
    expect(position.current).toBeUndefined();
    await expect(position.getPosition()).rejects.toThrow("尚未就绪");
    Object.defineProperty(media, "seeking", { value: false });
    expect(await position.getPosition()).toBe(38.125);
  });
  it("refuses positions while switching sources", async () => {
    const position = useRecordingMediaPosition("rec", video(), { mode: "live", loading: true }, null, clock());
    expect(position.current).toBeUndefined();
    await expect(position.getPosition()).rejects.toThrow("尚未就绪");
  });
  it("refuses unknown positions before media is available", async () => {
    const position = useRecordingMediaPosition("rec", video(), { mode: "live" }, null, clock(0));
    await expect(position.getPosition()).rejects.toThrow("尚未就绪");
    const unavailable = useRecordingMediaPosition(undefined, null, { mode: "live" }, null, clock());
    await expect(unavailable.getPosition()).rejects.toThrow("尚未就绪");
  });
});
