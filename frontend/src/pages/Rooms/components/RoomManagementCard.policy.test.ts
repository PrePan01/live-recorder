import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../../../types/room";
import { DEFAULT_ROOM_POLICY, type RoomPolicy } from "../model/roomPolicy";

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0,
  effects: [] as Array<() => void>,
  store: { editRoom: vi.fn(), favoriteRoom: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  memo: (component: unknown) => component,
  useLayoutEffect: () => {},
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (next: unknown) => {
      hooks.slots[slot] = typeof next === "function" ? next(hooks.slots[slot]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    return hooks.slots[slot] ??= { current: initial };
  },
}));
vi.mock("antd", () => ({
  Button: "button", Checkbox: "checkbox", Input: "input", Tag: "tag",
  Tooltip: "tooltip", Typography: { Link: "link" },
}));
vi.mock("@ant-design/icons", () => ({
  DeleteOutlined: "delete", EditOutlined: "edit", HolderOutlined: "holder",
  ScheduleOutlined: "schedule", StarFilled: "star", StarOutlined: "star", UndoOutlined: "undo",
}));
vi.mock("../../../stores/roomStore", () => ({
  useRoomStore: (select: (state: typeof hooks.store) => unknown) => select(hooks.store),
}));
vi.mock("../../../stores/settingsStore", () => ({ useSettingsStore: () => null }));
vi.mock("../../../components/RoomSortable", () => ({ useRoomSortableItem: () => ({}) }));
vi.mock("../../../components/PlatformLogo", () => ({ PlatformLogoTag: "platform" }));
vi.mock("../../../components/StatusTags", () => ({ MonitorStateTag: "status" }));
vi.mock("../../Monitor/components/RoomAvatar", () => ({ default: "avatar" }));
vi.mock("./RoomPolicyFields", () => ({ default: "policy-fields", RoomEnabledControl: "enabled" }));
import RoomManagementCard from "./RoomManagementCard";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function render(room: Room) {
  hooks.cursor = 0;
  hooks.effects = [];
  const component = RoomManagementCard as unknown as (props: Record<string, unknown>) => ReactNode;
  const tree = elements(component({ room, selected: false, onSelect: vi.fn(), onEdit: vi.fn(), onSchedule: vi.fn(), onDelete: vi.fn() }));
  hooks.effects.forEach(effect => effect());
  return {
    busy: tree[0].props["aria-busy"],
    fields: tree.find(el => el.type === "policy-fields")!.props as {
      value: RoomPolicy; disabled: boolean; status: ReactNode; onChange: (patch: RoomPolicy) => void;
    },
    enabled: tree.find(el => el.type === "enabled")!.props as { onChange: (enabled: boolean) => void },
    reset: tree.find(el => el.props["aria-label"] === "恢复 测试房间 的默认设置")?.props.onClick as (() => void) | undefined,
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  vi.resetAllMocks();
});

describe("room policy reset with overlapping saves", () => {
  const changes: Array<{ key: keyof RoomPolicy; patch: RoomPolicy }> = [
    { key: "checkIntervalSec", patch: { checkIntervalSec: 60 } },
    { key: "quality", patch: { quality: "720p" } },
    { key: "enabled", patch: { enabled: false } },
    { key: "autoRecord", patch: { autoRecord: true } },
    { key: "danmakuEnabled", patch: { danmakuEnabled: true } },
    { key: "liveNotificationEnabled", patch: { liveNotificationEnabled: true } },
  ];
  it.each(changes)("keeps $key stable until the deferred parent update arrives", async ({ key, patch }) => {
    const room = { id: "reset-room", displayName: "测试房间", tags: [], ...DEFAULT_ROOM_POLICY, checkIntervalSec: 30 } as unknown as Room;
    hooks.store.editRoom.mockResolvedValue(undefined);
    const initial = render(room);
    if (key === "enabled") initial.enabled.onChange(false);
    else initial.fields.onChange(patch);
    await Promise.resolve();
    // Store writes have completed, but the scheduler has not delivered new parent props yet.
    expect(render(room).fields.value[key]).toBe(patch[key]);
    const confirmed = { ...room, ...patch } as Room;
    render(confirmed);
    // Once acknowledged, a subsequent external edit must not be hidden by the old draft.
    expect(render(room).fields.value[key]).toBe(room[key]);
  });
  it.each(changes.flatMap(change => [false, true].map(failed => ({ ...change, failed }))))(
    "keeps $key at its reset value while an older save settles (failed=$failed)", async ({ key, patch, failed }) => {
    let room = { id: "reset-room", displayName: "测试房间", tags: [], ...DEFAULT_ROOM_POLICY, checkIntervalSec: 30 } as unknown as Room;
    const requests: Array<{ patch: RoomPolicy; resolve: () => void; reject: () => void }> = [];
    hooks.store.editRoom.mockImplementation((_id: string, patch: RoomPolicy) => new Promise<void>((resolve, reject) => {
      requests.push({ patch, resolve: () => { room = { ...room, ...patch } as Room; resolve(); }, reject: () => reject(new Error("old save failed")) });
    }));
    const initial = render(room);
    // Blur/save and reset can be dispatched before React paints the disabled controls.
    if (key === "enabled") initial.enabled.onChange(false);
    else initial.fields.onChange(patch);
    initial.reset!();
    expect(requests.map(request => request.patch[key])).toEqual([patch[key], DEFAULT_ROOM_POLICY[key]]);
    expect(render(room).fields.value[key]).toBe(DEFAULT_ROOM_POLICY[key]);
    if (failed) requests[0].reject(); else requests[0].resolve();
    await Promise.resolve();
    const pendingReset = render(room).fields;
    expect(pendingReset.value[key]).toBe(DEFAULT_ROOM_POLICY[key]);
    expect(pendingReset.disabled).not.toBe(true);
    expect(render(room).busy).toBe(true);
    expect(pendingReset.status).toBeUndefined();
    requests[1].resolve();
    await Promise.resolve();
    expect(render(room).fields.value[key]).toBe(DEFAULT_ROOM_POLICY[key]);
    expect(render(room).fields.disabled).not.toBe(true);
    expect(render(room).busy).toBe(false);
  });

  it("merges rapid edits without disabling other controls or losing earlier optimistic changes", async () => {
    const room = { id: "reset-room", displayName: "测试房间", tags: [], ...DEFAULT_ROOM_POLICY } as unknown as Room;
    const resolve: Array<() => void> = [];
    hooks.store.editRoom.mockImplementation(() => new Promise<void>(done => resolve.push(done)));
    const initial = render(room);
    initial.fields.onChange({ quality: "720p" });
    initial.fields.onChange({ checkIntervalSec: 45 });
    expect(hooks.store.editRoom.mock.calls.map(call => call[1])).toEqual([
      { quality: "720p" }, { quality: "720p", checkIntervalSec: 45 },
    ]);
    resolve[0]();
    await Promise.resolve();
    const pending = render(room);
    expect(pending.fields.disabled).not.toBe(true);
    expect(pending.fields.value).toMatchObject({ quality: "720p", checkIntervalSec: 45 });
    expect(pending.busy).toBe(true);
    resolve[1]();
    await Promise.resolve();
    expect(render(room).fields.value).toMatchObject({ quality: "720p", checkIntervalSec: 45 });
  });

  it("retains failed optimistic edits with a retry and clears the error after retry succeeds", async () => {
    const room = { id: "reset-room", displayName: "测试房间", tags: [], ...DEFAULT_ROOM_POLICY } as unknown as Room;
    hooks.store.editRoom.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    render(room).fields.onChange({ quality: "720p" });
    await Promise.resolve();
    const failed = render(room);
    expect(failed.fields.value.quality).toBe("720p");
    expect(failed.fields.status).toBeDefined();
    expect(failed.busy).toBe(false);
    const retry = elements(failed.fields.status).find(el => el.props.children === "重试")!;
    (retry.props.onClick as () => void)();
    await Promise.resolve();
    expect(hooks.store.editRoom).toHaveBeenLastCalledWith(room.id, { quality: "720p" });
    expect(render(room).fields.status).toBeUndefined();
    expect(render(room).fields.value.quality).toBe("720p");
  });
});
