import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSeekPlayback } from "./seekPlaybackHealth";

afterEach(() => vi.useRealTimers());
const fixture = () => ({ currentTime: 0, paused: false, ended: false });

describe("回看首帧与停滞检测", () => {
  it("没有首帧的失败不会永久加载，失败回调只发一次", () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const health = watchSeekPlayback(
      fixture() as HTMLVideoElement,
      failure,
      () => true,
    );
    vi.advanceTimersByTime(14_000);
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(failure).toHaveBeenCalledExactlyOnceWith("first-frame");
    health.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("有首帧后检测卡帧，主动暂停不会误触发恢复", () => {
    vi.useFakeTimers();
    const video = fixture();
    const failure = vi.fn();
    const health = watchSeekPlayback(
      video as HTMLVideoElement,
      failure,
      () => true,
    );
    health.presented();
    video.paused = true;
    vi.advanceTimersByTime(120_000);
    expect(failure).not.toHaveBeenCalled();
    video.paused = false;
    vi.advanceTimersByTime(11_000);
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(failure).toHaveBeenCalledExactlyOnceWith("stall");
    health.stop();
  });

  it("正常前进、回退和到达尾部均不视为停滞", () => {
    vi.useFakeTimers();
    const video = fixture();
    const failure = vi.fn();
    const health = watchSeekPlayback(
      video as HTMLVideoElement,
      failure,
      () => true,
    );
    health.presented();
    for (const time of [5, 10, 2, 3]) {
      video.currentTime = time;
      vi.advanceTimersByTime(10_000);
    }
    video.ended = true;
    vi.advanceTimersByTime(30_000);
    expect(failure).not.toHaveBeenCalled();
    health.stop();
  });

  it("旧代际和已清理的观察器不能报告失败", () => {
    vi.useFakeTimers();
    let current = true;
    const failure = vi.fn();
    const health = watchSeekPlayback(
      fixture() as HTMLVideoElement,
      failure,
      () => current,
    );
    current = false;
    vi.advanceTimersByTime(30_000);
    expect(failure).not.toHaveBeenCalled();
    health.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
