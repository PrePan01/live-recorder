import { afterEach, describe, expect, it, vi } from "vitest";
import { createHoverPreviewController } from "./hoverPreview";

afterEach(() => vi.useRealTimers());

describe("hover preview lifecycle", () => {
  it("does not open streams for quick pointer passes", () => {
    vi.useFakeTimers();
    const preview = createHoverPreviewController();
    const owner = Symbol();
    preview.request(owner, () => true);
    vi.advanceTimersByTime(349);
    expect(preview.isActive(owner)).toBe(false);
    preview.cancel(owner);
    vi.runAllTimers();
    expect(preview.isActive(owner)).toBe(false);
  });

  it("allows only the latest hovered cover and ignores stale cleanup", () => {
    vi.useFakeTimers();
    const preview = createHoverPreviewController();
    const a = Symbol(), b = Symbol();
    preview.request(a, () => true);
    vi.advanceTimersByTime(350);
    expect(preview.isActive(a)).toBe(true);
    preview.request(b, () => true);
    expect(preview.isActive(a)).toBe(false);
    preview.cancel(a);
    vi.advanceTimersByTime(350);
    expect(preview.isActive(b)).toBe(true);
    preview.cancel(b);
    expect(preview.isActive(b)).toBe(false);
  });

  it("cancels pending ownership when crossing covers or unmounting", () => {
    vi.useFakeTimers();
    const preview = createHoverPreviewController();
    const a = Symbol(), b = Symbol();
    preview.request(a, () => true);
    vi.advanceTimersByTime(300);
    preview.request(b, () => true);
    vi.advanceTimersByTime(50);
    expect(preview.isActive(a)).toBe(false);
    preview.cancel(b);
    vi.runAllTimers();
    expect(preview.isActive(b)).toBe(false);
  });

  it("checks visibility again before starting and unsubscribes listeners", () => {
    vi.useFakeTimers();
    const preview = createHoverPreviewController();
    const owner = Symbol();
    const listener = vi.fn();
    const unsubscribe = preview.subscribe(listener);
    preview.request(owner, () => false);
    vi.runAllTimers();
    expect(preview.isActive(owner)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    preview.request(owner, () => true);
    vi.runAllTimers();
    preview.cancel(owner);
    expect(listener).not.toHaveBeenCalled();
  });
});
