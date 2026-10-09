import { describe, expect, it, vi } from "vitest";
import { listenMouseDrag } from "./mouseDrag";

function gesture() {
  const target = new EventTarget();
  const onMove = vi.fn();
  const onEnd = vi.fn();
  const onCancel = vi.fn();
  const cancel = listenMouseDrag({ onMove, onEnd, onCancel }, target);
  return { target, onMove, onEnd, onCancel, cancel };
}

describe("mouse drag lifecycle", () => {
  it("delivers moves and the final release once, then removes global listeners", () => {
    const { target, onMove, onEnd, onCancel, cancel } = gesture();
    target.dispatchEvent(new Event("mousemove"));
    const release = new Event("mouseup");
    target.dispatchEvent(release);
    target.dispatchEvent(new Event("mousemove"));
    target.dispatchEvent(new Event("mouseup"));
    target.dispatchEvent(new Event("blur"));
    cancel();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(release);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each(["blur", "unmount"])(
    "cancels an interrupted gesture on %s",
    (reason) => {
      const { target, onMove, onEnd, onCancel, cancel } = gesture();
      if (reason === "blur") target.dispatchEvent(new Event("blur"));
      else cancel();
      cancel();
      target.dispatchEvent(new Event("mousemove"));
      target.dispatchEvent(new Event("mouseup"));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onEnd).not.toHaveBeenCalled();
      expect(onMove).not.toHaveBeenCalled();
    },
  );
});
