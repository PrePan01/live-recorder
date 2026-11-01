import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DouyinEnterLog,
  DOUYIN_ENTER_LOG_INTERVAL_MS,
  DOUYIN_ENTER_LOG_MAX_ROOMS,
} from "../../src/platform/douyin/enter-log.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Douyin enter log aggregation", () => {
  it("logs once for 50000 repeats without registering timers, then summarizes every ten minutes", () => {
    const logger = new DouyinEnterLog();
    const shape = "[douyin-enter] room=1 status_code=4003034";
    for (let i = 0; i < 50_000; i++) logger.warn("1", shape);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DOUYIN_ENTER_LOG_INTERVAL_MS - 1);
    logger.warn("1", shape);
    expect(console.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    logger.warn("1", shape);
    expect(console.warn).toHaveBeenLastCalledWith(shape + " suppressed=50000");
    vi.advanceTimersByTime(DOUYIN_ENTER_LOG_INTERVAL_MS);
    logger.warn("1", shape);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenLastCalledWith(shape);
  });

  it("logs changed responses immediately and does not mix independent rooms", () => {
    const logger = new DouyinEnterLog();
    logger.warn("1", "status=4003034 hint=visibility");
    logger.warn("1", "status=4003034 hint=visibility");
    logger.warn("2", "status=4003034 hint=visibility");
    logger.warn("1", "status=4003073 hint=unavailable");
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenLastCalledWith(
      "status=4003073 hint=unavailable previousSuppressed=1",
    );
    logger.warn("1", "status=4003073 hint=changed");
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it("summarizes recovery once and reports a recurrence immediately", () => {
    const logger = new DouyinEnterLog();
    logger.recovered("1");
    expect(console.log).not.toHaveBeenCalled();
    logger.warn("1", "same failure");
    logger.warn("1", "same failure");
    logger.recovered("1");
    logger.recovered("1");
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "[douyin-enter] room=1 recovered suppressed=1",
    );
    logger.warn("1", "same failure");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("bounds remembered rooms and evicts only the oldest entry when full", () => {
    const logger = new DouyinEnterLog();
    for (let i = 0; i <= DOUYIN_ENTER_LOG_MAX_ROOMS; i++)
      logger.warn(String(i), `failure-${i}`);
    expect(console.warn).toHaveBeenCalledTimes(DOUYIN_ENTER_LOG_MAX_ROOMS + 1);
    logger.warn("1", "failure-1");
    expect(console.warn).toHaveBeenCalledTimes(DOUYIN_ENTER_LOG_MAX_ROOMS + 1);
    logger.warn("0", "failure-0");
    expect(console.warn).toHaveBeenCalledTimes(DOUYIN_ENTER_LOG_MAX_ROOMS + 2);
  });

  it("keeps adapter instances independent and handles a backwards clock adjustment", () => {
    const first = new DouyinEnterLog();
    const second = new DouyinEnterLog();
    first.warn("1", "failure");
    second.warn("1", "failure");
    expect(console.warn).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-31T23:00:00Z"));
    first.warn("1", "failure");
    expect(console.warn).toHaveBeenCalledTimes(3);
    first.warn("1", "failure");
    expect(console.warn).toHaveBeenCalledTimes(3);
  });
});
