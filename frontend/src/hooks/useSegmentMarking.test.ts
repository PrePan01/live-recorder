import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  store: {
    recordingId: "r" as string | null,
    start: null as number | null,
    end: null as number | null,
  },
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (v: unknown) => {
        h.slots[i] = v;
      },
    ];
  },
  useRef: (value: unknown) => {
    const i = h.cursor++;
    return (h.slots[i] ??= { current: value });
  },
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) } }));
vi.mock("../stores/segmentDraftStore", () => {
  const state = Object.assign(h.store, {
    activate: (id: string) => {
      if (h.store.recordingId !== id) {
        h.store.recordingId = id;
        h.store.start = null;
        h.store.end = null;
      }
    },
    setStart: (id: string, start: number | null) => {
      h.store.recordingId = id;
      h.store.start = start;
      h.store.end = null;
    },
  });
  Object.assign(state, {
    setEnd: (_id: string, end: number) => {
      h.store.end = end;
    },
  });
  return {
    useSegmentDraftStore: Object.assign(
      (select: (s: unknown) => unknown) => select(state),
      { getState: () => state },
    ),
  };
});
vi.mock("../api/recordings", () => ({
  createRecordingMarker: vi
    .fn()
    .mockImplementation(
      async (recordingId, text, positionSeconds, endPositionSeconds) => ({
        id: "m",
        recordingId,
        text,
        positionSeconds,
        endPositionSeconds,
      }),
    ),
}));
import { createRecordingMarker } from "../api/recordings";
import { useSegmentMarking } from "./useSegmentMarking";
import type { RecordingMarker } from "../types/recording";
function render(
  position: number | Promise<number>,
  onSaved = vi.fn(),
  markers: RecordingMarker[] = [],
) {
  h.cursor = 0;
  return useSegmentMarking("r", markers, async () => position, onSaved);
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.store.recordingId = "r";
  h.store.start = null;
  h.store.end = null;
  vi.clearAllMocks();
});
describe("two-click segment marking", () => {
  it("starts without writing and then saves the range with a default name", async () => {
    await render(2).mark();
    expect(h.store.start).toBe(2);
    expect(createRecordingMarker).not.toHaveBeenCalled();
    await render(8).mark();
    expect(createRecordingMarker).toHaveBeenCalledWith("r", "片段 1", 2, 8);
    expect(h.store.start).toBeNull();
  });
  it("swaps boundaries when the user seeks backwards", async () => {
    await render(12).mark();
    await render(4).mark();
    expect(createRecordingMarker).toHaveBeenCalledWith("r", "片段 1", 4, 12);
  });
  it.each([2, 2.5])(
    "retains the first position when the range is shorter than a second: %s",
    async (position) => {
      await render(2).mark();
      await render(position).mark();
      expect(h.store.start).toBe(2);
      expect(createRecordingMarker).not.toHaveBeenCalled();
      expect(h.message.warning).toHaveBeenCalledWith("片段至少需要 1 秒");
    },
  );
  it("retains both positions on save failure so retrying does not change the segment", async () => {
    await render(2).mark();
    vi.mocked(createRecordingMarker).mockRejectedValueOnce(
      new Error("offline"),
    );
    await render(8).mark();
    expect(h.store.start).toBe(2);
    await render(9).mark();
    expect(createRecordingMarker).toHaveBeenLastCalledWith("r", "片段 1", 2, 8);
    expect(h.store.start).toBeNull();
  });
  it("locks concurrent clicks while reading the actual media position", async () => {
    let release!: (position: number) => void;
    const pending = new Promise<number>((r) => {
      release = r;
    });
    const hook = render(pending);
    const first = hook.mark();
    await hook.mark();
    release(3);
    await first;
    expect(h.store.start).toBe(3);
    expect(createRecordingMarker).not.toHaveBeenCalled();
  });
  it("abandons the current range without a write", async () => {
    await render(3).mark();
    render(8).cancel();
    expect(h.store.start).toBeNull();
    expect(createRecordingMarker).not.toHaveBeenCalled();
  });
});
