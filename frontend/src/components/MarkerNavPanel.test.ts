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
vi.mock("antd", () => ({ Button: "mock-button", Checkbox: "mock-checkbox", Input: "mock-input", InputNumber: "mock-number", Modal: "mock-modal", Popconfirm: "mock-confirm", Space: "mock-space", Typography: { Text: "mock-text" } }));
import { MarkerNavPanel } from "./MarkerNavPanel";
const marker: RecordingMarker = { id: "segment", recordingId: "r", text: "片段 1", positionSeconds: 3, endPositionSeconds: 8, createdAt: "", updatedAt: "" };
function render(onSeek: (second: number) => void) {
  h.cursor = 0;
  return MarkerNavPanel({ markers: [marker], duration: 20, onSeek, onEdit: vi.fn(), onRangeEdit: vi.fn(), liveMode: true });
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
    expect(find(tree, (node) => node.props["aria-label"] === "片段起点")!.props.value).toBe(3);
    expect(find(tree, (node) => node.props["aria-label"] === "片段终点")!.props.value).toBe(8);
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
