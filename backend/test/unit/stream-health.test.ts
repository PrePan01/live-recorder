import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamHealth } from "../../src/recorder/stream-health.js";

afterEach(() => vi.useRealTimers());
describe("upstream health clock", () => {
  it("excludes local writer and consumer waits from both idle clocks", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const interrupt = vi.fn();
    const health = new StreamHealth(15000, 30000, interrupt);
    health.received(true, true);
    health.begin();
    vi.advanceTimersByTime(5000);
    health.pause();
    vi.advanceTimersByTime(60000);
    expect(interrupt).not.toHaveBeenCalled();
    health.received(true, true);
    health.begin();
    vi.advanceTimersByTime(14999);
    health.pause();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("confirms real silence, but permits queued data to cancel an overdue timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const interrupt = vi.fn();
    const health = new StreamHealth(15000, 30000, interrupt);
    health.received(true, true);
    health.begin();
    vi.advanceTimersByTime(15000);
    expect(interrupt).not.toHaveBeenCalled();
    health.pause();
    health.received(true, true);
    health.begin();
    vi.advanceTimersByTime(15250);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(() => health.check()).toThrow("直播源持续无数据");
    health.pause();
  });

  it("detects frozen media despite arriving bytes and reports its own cause", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const interrupt = vi.fn();
    const health = new StreamHealth(15000, 30000, interrupt);
    health.received(false, true);
    for (let i = 0; i < 29; i++) {
      health.begin();
      vi.advanceTimersByTime(1000);
      health.pause();
      health.received(false, true);
    }
    health.begin();
    vi.advanceTimersByTime(1250);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(() => health.check()).toThrow("媒体进度持续停滞");
    health.pause();
  });
});
