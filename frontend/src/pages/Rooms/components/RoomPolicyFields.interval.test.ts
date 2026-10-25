import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomPolicy } from "../model/roomPolicy";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useId: () => "interval-test",
  useEffect: () => {},
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (next: unknown) => { hooks.slots[slot] = next; }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    return hooks.slots[slot] ??= { current: initial };
  },
}));
vi.mock("antd", () => ({ InputNumber: "number", Select: "select", Switch: "switch", Tooltip: "tooltip" }));
import RoomPolicyFields from "./RoomPolicyFields";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function render(onChange: (patch: RoomPolicy) => void, value: RoomPolicy = { checkIntervalSec: 30 }, disabled = false) {
  hooks.cursor = 0;
  const tree = elements(RoomPolicyFields({ value, disabled, settings: null, presentation: "console", onChange }));
  const select = tree.find(el => el.props["aria-label"] === "检测间隔")!;
  const popup = (select.props.popupRender as (menu: ReactNode) => ReactNode)(null);
  return elements(popup).find(el => el.props["aria-label"] === "自定义检测间隔秒数")!.props as {
    onChange: (value: number) => void; onBlur: () => void; onPressEnter: () => void;
  };
}
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; });

describe("custom detection interval commits", () => {
  it("does not save twice when Enter is followed by blur before another render", () => {
    const save = vi.fn();
    render(save).onChange(45);
    const input = render(save);
    input.onPressEnter();
    input.onBlur();
    expect(save.mock.calls).toEqual([[{ checkIntervalSec: 45 }]]);
  });

  it("does not restore a dirty custom interval after the policy resets to inheritance", () => {
    const save = vi.fn();
    render(save).onChange(45);
    render(save, { checkIntervalSec: null }).onBlur();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not commit blur while a reset is saving and disables the controls", () => {
    const save = vi.fn();
    render(save).onChange(45);
    render(save, { checkIntervalSec: 30 }, true).onBlur();
    expect(save).not.toHaveBeenCalled();
  });
});
