import { afterEach, expect, it, vi } from "vitest";
import { startAutoKeepCountdown } from "./autoKeepCountdown";

afterEach(() => vi.useRealTimers());

it("counts down every second and preserves once after ten seconds", () => {
  vi.useFakeTimers();
  const tick = vi.fn();
  const keep = vi.fn();
  startAutoKeepCountdown(tick, keep);
  vi.advanceTimersByTime(9000);
  expect(tick.mock.calls.map(([seconds]) => seconds)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(keep).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(keep).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(20000);
  expect(keep).toHaveBeenCalledTimes(1);
});

it("cancels automatic preservation when the user decides or the prompt unmounts", () => {
  vi.useFakeTimers();
  const keep = vi.fn();
  const cancel = startAutoKeepCountdown(vi.fn(), keep);
  vi.advanceTimersByTime(3000);
  cancel();
  vi.advanceTimersByTime(10000);
  expect(keep).not.toHaveBeenCalled();
});

it("gives the next queued prompt its own full ten seconds", () => {
  vi.useFakeTimers();
  const first = vi.fn();
  const next = vi.fn();
  startAutoKeepCountdown(vi.fn(), first);
  vi.advanceTimersByTime(10000);
  expect(first).toHaveBeenCalledTimes(1);
  startAutoKeepCountdown(vi.fn(), next);
  vi.advanceTimersByTime(9000);
  expect(next).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(next).toHaveBeenCalledTimes(1);
});
