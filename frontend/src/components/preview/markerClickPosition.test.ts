import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingTrackProps } from "../recording-track/types";
import type { Room } from "../../types/room";
import { useRecordingTrack } from "../recording-track/useRecordingTrack";
import { usePreviewMarkers } from "./usePreviewMarkers";
import { useRecordingMediaPosition } from "../../hooks/useRecordingMediaPosition";

// Keep hook state across renders without requiring a browser or DOM renderer.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] =
          typeof value === "function" ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current: initial });
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useLayoutEffect: () => undefined,
}));
vi.mock("../../hooks/useLocalPref", () => ({
  useLocalPref: () => [false, vi.fn()],
}));
vi.mock("../../stores/recordingStore", () => ({
  useRecordingStore: () => vi.fn(),
}));
vi.mock("antd", () => ({
  App: { useApp: () => ({ message: { success: vi.fn(), error: vi.fn() } }) },
}));
vi.mock("../../api/recordings", () => ({
  createRecordingMarker: vi.fn().mockResolvedValue({ id: "marker-1" }),
  fetchRecordingMarkers: vi.fn().mockResolvedValue([]),
}));
import { createRecordingMarker } from "../../api/recordings";

function RecordingTrackHarness(props: Partial<RecordingTrackProps> = {}) {
  hooks.cursor = 0;
  hooks.effects = [];
  return useRecordingTrack({
    elapsedSeconds: 93,
    markers: [],
    previewMode: "live",
    ...props,
  });
}
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
});

describe("marker click position", () => {
  it.each([
    [0, 8, 8, 0], [0, 8, 18, 10],
    [100, 92, 92, 100], [100, 92, 82, 90],
  ])("keeps the endpoint playhead's grip offset at %s seconds", (second, press, release, expected) => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let cleanup: (() => void) | undefined;
    const onSeekCommit = vi.fn();
    const props = { mode: "playback" as const, elapsedSeconds: 100,
      previewMode: "history" as const, previewSecond: second, onSeekCommit };
    try {
      let track = RecordingTrackHarness(props);
      track.railRef.current = { offsetWidth: 100, clientWidth: 100, clientLeft: 0,
        getBoundingClientRect: () => ({ left: 0, width: 100 }) } as HTMLDivElement;
      track.beginPlayhead({ clientX: press, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.PointerEvent, true);
      track = RecordingTrackHarness(props);
      expect(track.positionSecond).toBe(second);
      cleanup = hooks.effects.at(-1)!() as () => void;
      const event = new Event("pointerup");
      Object.defineProperty(event, "clientX", { value: release });
      target.dispatchEvent(event);
      expect(onSeekCommit).toHaveBeenCalledWith(expected, expected);
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });
  it.each([
    ["start", 14, 14, [0, 100]],
    ["start", 14, 24, [10, 100]],
    ["end", 86, 86, [0, 100]],
    ["end", 86, 76, [0, 90]],
  ] as const)("preserves the grip offset of the inward %s handle", (kind, press, release, expected) => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let cleanup: (() => void) | undefined;
    const props = { mode: "playback" as const, elapsedSeconds: 100, onExport: vi.fn() };
    try {
      let track = RecordingTrackHarness(props);
      track.railRef.current = { offsetWidth: 100, clientWidth: 100, clientLeft: 0,
        getBoundingClientRect: () => ({ left: 0, width: 100 }) } as HTMLDivElement;
      track.beginRange(kind, { clientX: press, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.PointerEvent);
      track = RecordingTrackHarness(props);
      cleanup = hooks.effects.at(-1)!() as () => void;
      const event = new Event("pointerup");
      Object.defineProperty(event, "clientX", { value: release });
      target.dispatchEvent(event);
      track = RecordingTrackHarness(props);
      expect(track.range).toEqual(expected);
      expect(props.onExport).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });
  it.each([
    ["playback", 100, 40, 25, 45],
    ["playback", 100, -20, 0, 20],
    ["playback", 100, 150, 80, 100],
    ["recording", 120, 40, 25, 45],
    ["recording", 120, -20, 0, 20],
    ["recording", 120, 150, 80, 100],
    ["playback", 100, 150, 79.125, 99.125],
  ] as const)("moves a whole segment in %s mode without changing its duration", async (mode, width, pointerEnd, start, end) => {
    const marker = { id: "segment", recordingId: "r", text: "片段", positionSeconds: 10, endPositionSeconds: 30, createdAt: "", updatedAt: "" };
    const onMove = vi.fn().mockResolvedValue(undefined);
    const onSeekCommit = vi.fn();
    const props = { mode, elapsedSeconds: end === 99.125 ? end : 100, markers: [marker], editable: true, onMove, onSeekCommit };
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    let frame: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let cleanup: (() => void) | undefined;
    try {
      let track = RecordingTrackHarness(props);
      const timelineEnd = mode === "recording" ? 120 : props.elapsedSeconds;
      track.railRef.current = { offsetWidth: width, clientWidth: width, clientLeft: 0,
        getBoundingClientRect: () => ({ left: 0, width }) } as HTMLDivElement;
      track.beginMarker(marker, { clientX: 25 * width / timelineEnd, stopPropagation: vi.fn(), preventDefault: vi.fn() } as unknown as React.PointerEvent);
      track = RecordingTrackHarness(props);
      expect(track.dragging).toMatchObject({ markerId: "segment", duration: 20 });
      cleanup = hooks.effects.at(-1)!() as () => void;
      const dispatch = (type: string) => {
        const event = new Event(type);
        Object.defineProperty(event, "clientX", { value: pointerEnd * width / timelineEnd });
        target.dispatchEvent(event);
      };
      dispatch("pointermove");
      frame!();
      track = RecordingTrackHarness(props);
      expect(track.markerPositions.segment).toBe(start);
      dispatch("pointerup");
      expect(onMove).toHaveBeenCalledWith("segment", start, end);
      expect(onSeekCommit).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
      track = RecordingTrackHarness(props);
      expect(track.markerPositions.segment).toBeUndefined();
      expect(track.dragging).toBeNull();
    } finally {
      cleanup?.();
      vi.unstubAllGlobals();
    }
  });
  it("isolates a segment press from the rail and clears stale drag state before double-click editing", async () => {
    const marker = { id: "segment", recordingId: "r", text: "片段", positionSeconds: 3, endPositionSeconds: 8, createdAt: "", updatedAt: "" };
    let track = RecordingTrackHarness({ editable: true });
    track.movedRef.current = true;
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    track.beginMarker(marker, event as unknown as React.PointerEvent);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(track.movedRef.current).toBe(false);
    await track.openEdit(marker);
    track = RecordingTrackHarness({ editable: true });
    expect(track.editing).toEqual(marker);
    expect(track.editorOpen).toBe(true);
  });
  it("adjusts the temporary selection without exporting or changing saved markers", () => {
    const onSelectionChange = vi.fn();
    const onExport = vi.fn();
    const props = { onSelectionChange, onExport };
    let track = RecordingTrackHarness(props);
    track.onHandleKeyDown("start", { key: "ArrowRight", preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
    track = RecordingTrackHarness(props);
    expect(track.range).toEqual([1, 93]);
    expect(createRecordingMarker).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });
  it("live indicator follows the recorded tail while the label locks the fresh click position", async () => {
    let second = 10.125;
    const getMarkerPosition = vi.fn(async () => second);
    const onAdd = vi.fn().mockResolvedValue(undefined);
    let track = RecordingTrackHarness({ onAdd, getMarkerPosition, previewSecond: 8 });
    expect(track.positionSecond).toBe(93);
    const opened = track.openEdit();
    second = 20;
    await opened;
    track.setDraft("精确标签");
    track = RecordingTrackHarness({ onAdd, getMarkerPosition, previewSecond: 18 });
    expect(track.positionSecond).toBe(93);
    await track.submit();
    expect(onAdd).toHaveBeenCalledWith("精确标签", 10.125);
    expect(getMarkerPosition).toHaveBeenCalledOnce();
  });

  it("does not create two labels when Enter and Save submit the same pending editor", async () => {
    let release!: () => void;
    const onAdd = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    let track = RecordingTrackHarness({ onAdd });
    await track.openEdit();
    track.setDraft("标签");
    track = RecordingTrackHarness({ onAdd });
    const first = track.submit();
    await track.submit();
    expect(onAdd).toHaveBeenCalledOnce();
    release(); await first;
  });

  it("quick marker saves the visible live tail even when the decoded video lags by two seconds", async () => {
    const video = { readyState: 2, currentTime: 8.125 } as HTMLVideoElement;
    const media = useRecordingMediaPosition("recording-1", video, { mode: "live" }, null,
      { durationSeconds: 10.125, previewOffsetSeconds: 0, update: vi.fn() });
    const room = { id: "room-1" } as Room;
    const markers = usePreviewMarkers(room, room, "recording-1", { current: "recording-1" },
      { mode: "live" }, false, 10.125, media.getPosition);
    markers.quickAddMarker();
    video.currentTime = 9;
    await Promise.resolve();
    expect(createRecordingMarker).toHaveBeenCalledWith("recording-1", "标记 1", 10.125);
  });

  it("quick marker reads the fresh media clock instead of the stale timeline", async () => {
    const room = { id: "room-1" } as Room;
    let second = 10.125;
    const getPosition = vi.fn(async () => second);
    const markers = usePreviewMarkers(room, room, "recording-1", { current: "recording-1" },
      { mode: "history", second: 8 }, false, 12, getPosition);
    markers.quickAddMarker();
    second = 20;
    await Promise.resolve();
    expect(createRecordingMarker).toHaveBeenCalledWith("recording-1", "标记 1", 10.125);
  });

  it.each([
    ["live", undefined, 93],
    ["history", 33.9, 33],
  ] as const)(
    "quick marker captures the displayed %s second",
    (mode, second, expected) => {
      const room = { id: "room-1" } as Room;
      const markers = usePreviewMarkers(
        room,
        room,
        "recording-1",
        { current: "recording-1" },
        { mode, second },
        false,
        93,
      );
      markers.quickAddMarker();
      expect(createRecordingMarker).toHaveBeenCalledWith(
        "recording-1",
        "标记 1",
        expected,
      );
    },
  );

  it.each([
    ["live", undefined, 93],
    ["history", 33.9, 33],
  ] as const)(
    "label keeps the %s click position while typing and saving",
    async (previewMode, previewSecond, expected) => {
      const onAdd = vi
        .fn()
        .mockRejectedValueOnce(new Error("save failed"))
        .mockResolvedValue(undefined);
      let track = RecordingTrackHarness({ onAdd, previewMode, previewSecond });
      track.openEdit();
      track.setDraft("精彩时刻");
      track = RecordingTrackHarness({
        onAdd,
        elapsedSeconds: 120,
        previewMode,
        previewSecond: 60.5,
      });
      await track.submit();
      expect(onAdd).toHaveBeenLastCalledWith("精彩时刻", expected);
      // Retry also retains the original click position.
      track = RecordingTrackHarness({
        onAdd,
        elapsedSeconds: 130,
        previewMode,
        previewSecond: 70.5,
      });
      await track.submit();
      expect(onAdd).toHaveBeenLastCalledWith("精彩时刻", expected);
      // A newly opened label captures its own position.
      track.openEdit();
      track.setDraft("新标签");
      track = RecordingTrackHarness({
        onAdd,
        elapsedSeconds: 140,
        previewMode,
        previewSecond: 80.5,
      });
      await track.submit();
      expect(onAdd).toHaveBeenLastCalledWith(
        "新标签",
        previewMode === "live" ? 130 : 70,
      );
    },
  );
});
