import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingTrackProps } from "../recording-track/types";
import type { Room } from "../../types/room";
import { useRecordingTrack } from "../recording-track/useRecordingTrack";
import { usePreviewMarkers } from "./usePreviewMarkers";

// Keep hook state across renders without requiring a browser or DOM renderer.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
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
  useEffect: () => undefined,
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
