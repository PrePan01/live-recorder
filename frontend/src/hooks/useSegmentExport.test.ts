import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  message: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (value: unknown) => {
        h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    return (h.slots[i] ??= { current: initial });
  },
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: h.message }) } }));
vi.mock("../api/clipQueue", () => ({
  exportClipSegments: vi.fn().mockResolvedValue("batch"),
}));
import { useSegmentExport } from "./useSegmentExport";
import { exportClipSegments } from "../api/clipQueue";
import type { RecordingMarker } from "../types/recording";
const markers: RecordingMarker[] = [
  {
    id: "a",
    recordingId: "r",
    text: "片段 1",
    positionSeconds: 0,
    endPositionSeconds: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "b",
    recordingId: "r",
    text: "片段 2",
    positionSeconds: 3,
    endPositionSeconds: 8,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "point",
    recordingId: "r",
    text: "标签",
    positionSeconds: 1,
    createdAt: "",
    updatedAt: "",
  },
];
function render(id = "r", items = markers) {
  h.cursor = 0;
  // React is mocked above; this helper drives the simulated hook state.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  return useSegmentExport(id, items);
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  vi.clearAllMocks();
});
describe("select before exporting segments", () => {
  it("first enters selection mode and submits only checked segments on the next click", async () => {
    render().selectOrSubmit();
    expect(exportClipSegments).not.toHaveBeenCalled();
    const selecting = render();
    expect(selecting.selecting).toBe(true);
    expect(selecting.selectedIds).toEqual([]);
    selecting.select("b", true);
    render().select("point", true);
    expect(render().selectedIds).toEqual(["b"]);
    render().selectOrSubmit();
    expect(exportClipSegments).toHaveBeenCalledWith(
      "r",
      ["b"],
      expect.any(String),
    );
    await Promise.resolve();
  });
  it("does not submit an empty selection and removes unchecked or deleted segments", () => {
    render().selectOrSubmit();
    render().selectOrSubmit();
    expect(exportClipSegments).not.toHaveBeenCalled();
    expect(render().selecting).toBe(false);
    expect(render().selectedIds).toEqual([]);
    render().selectOrSubmit();
    render().select("a", true);
    render().select("b", true);
    render().select("a", false);
    expect(render().selectedIds).toEqual(["b"]);
    expect(
      render(
        "r",
        markers.filter((m) => m.id !== "b"),
      ).selectedIds,
    ).toEqual([]);
  });
  it("clears selection when switching recordings, including switching back", () => {
    render().selectOrSubmit();
    render().select("a", true);
    render("other", []);
    expect(render("other", []).selecting).toBe(false);
    render("r");
    expect(render().selecting).toBe(false);
    expect(render().selectedIds).toEqual([]);
  });
});
