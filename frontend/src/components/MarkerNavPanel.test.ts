import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RecordingMarker } from "../types/recording";
const h = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], (value: unknown) => { h.slots[i] = value; }];
  },
  useRef: (initial: unknown) => h.slots[h.cursor++] ??= { current: initial },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: () => undefined,
}));
vi.mock("antd", () => ({ Button: "mock-button", Checkbox: "mock-checkbox", Input: "mock-input", InputNumber: "mock-number", Modal: "mock-modal", Popconfirm: "mock-confirm", Tooltip: "mock-tooltip", Space: "mock-space", Typography: { Text: "mock-text" } }));
import { MarkerNavPanel } from "./MarkerNavPanel";
import { PendingSegmentRow, type PendingSegment } from "./PendingSegmentRow";
const marker: RecordingMarker = { id: "segment", recordingId: "r", text: "片段 1", positionSeconds: 3, endPositionSeconds: 8, createdAt: "", updatedAt: "" };
function render(onSeek: (second: number) => void, props: Partial<Parameters<typeof MarkerNavPanel>[0]> = {}) {
  h.cursor = 0;
  return MarkerNavPanel({ markers: [marker], duration: 20, onSeek, onEdit: vi.fn(), onRangeEdit: vi.fn(), liveMode: true, ...props });
}
function find(node: unknown, match: (node: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  return match(element) ? element : find(element.props.children, match);
}
beforeEach(() => { h.slots = []; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("segment list interaction", () => {
  it("shows an unfinished segment even when the saved list is empty", () => {
    const pendingSegment = { start: 3, text: "片段 1", saving: false, onEdit: vi.fn(), onDelete: vi.fn() };
    const tree = render(vi.fn(), { markers: [], pendingSegment });
    expect(tree).not.toBeNull();
    expect(find(tree, (node) => node.type === PendingSegmentRow)!.props.segment).toBe(pendingSegment);
  });
  it("lets an unfinished segment be renamed or cancelled with only two row actions", () => {
    const segment: PendingSegment = { start: 3, text: "片段 1", saving: false, onEdit: vi.fn(), onDelete: vi.fn() };
    const renderPending = () => { h.cursor = 0; return PendingSegmentRow({ segment, timeWidth: 10 }); };
    let tree = renderPending();
    const time = find(tree, (node) => node.type === "time")!;
    expect((time.props.children as unknown[]).join("")).toBe("00:03—???");
    for (const label of ["预览 片段 1", "调整 片段 1 范围", "导出 片段 1", "选择 片段 1"]) {
      expect(find(tree, (node) => node.props["aria-label"] === label)).toBeUndefined();
    }
    (find(tree, (node) => node.props["aria-label"] === "编辑 片段 1")!.props.onClick as () => void)();
    tree = renderPending();
    expect(find(tree, (node) => node.type === "mock-modal")!.props.open).toBe(true);
    (find(tree, (node) => node.props["aria-label"] === "标记文字")!.props.onChange as (e: unknown) => void)({ target: { value: "  精彩片段  " } });
    (find(renderPending(), (node) => node.type === "mock-modal")!.props.onOk as () => void)();
    expect(segment.onEdit).toHaveBeenCalledExactlyOnceWith("精彩片段");
    expect(find(renderPending(), (node) => node.type === "mock-modal")!.props.open).toBe(false);
    (find(renderPending(), (node) => node.props["aria-label"] === "删除 片段 1")!.props.onClick as () => void)();
    expect(segment.onDelete).toHaveBeenCalledTimes(1);
  });
  it("exports the clicked segment directly and explains every row action", () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    const point = { ...marker, id: "point", text: "标签", endPositionSeconds: null };
    const props = { markers: [marker, point], onExport, onPreview: vi.fn(), onAdjustRange: vi.fn(), onDelete: vi.fn() };
    const tree = render(vi.fn(), props);
    const button = find(tree, (node) => node.props["aria-label"] === "导出 片段 1")!;
    (button.props.onClick as () => void)();
    expect(onExport).toHaveBeenCalledExactlyOnceWith(marker);
    expect(find(tree, (node) => node.props["aria-label"] === "导出 标签")).toBeUndefined();
    for (const title of ["编辑", "跳转", "调整", "导出", "删除"]) {
      expect(find(tree, (node) => node.type === "mock-tooltip" && node.props.title === title)).toBeDefined();
    }
    const busyTree = render(vi.fn(), { ...props, exportBusy: true });
    expect(find(busyTree, (node) => node.props["aria-label"] === "导出 片段 1")!.props.disabled).toBe(true);
  });
  it("opens the segment editor on double-click without starting the pending preview", () => {
    const onSeek = vi.fn();
    const button = find(render(onSeek), (node) => node.props.className === "lr-marker-nav__seek")!;
    const click = button.props.onClick as (event: { detail: number }) => void;
    click({ detail: 1 });
    click({ detail: 2 });
    (button.props.onDoubleClick as () => void)();
    vi.advanceTimersByTime(500);
    expect(onSeek).not.toHaveBeenCalled();
    const tree = render(onSeek);
    expect(find(tree, (node) => node.type === "mock-modal")!.props.open).toBe(true);
    expect(find(tree, (node) => node.props["aria-label"] === "标记文字")!.props.value).toBe("片段 1");
    expect(find(tree, (node) => node.props["aria-label"] === "片段起点")).toBeUndefined();
    expect(find(tree, (node) => node.props["aria-label"] === "片段终点")).toBeUndefined();
  });
  it("still previews a single click and keyboard activation", () => {
    const onSeek = vi.fn();
    const button = find(render(onSeek), (node) => node.props.className === "lr-marker-nav__seek")!;
    const click = button.props.onClick as (event: { detail: number }) => void;
    click({ detail: 1 });
    vi.advanceTimersByTime(500);
    expect(onSeek).toHaveBeenCalledWith(3);
    click({ detail: 0 });
    expect(onSeek).toHaveBeenCalledTimes(2);
  });
});
