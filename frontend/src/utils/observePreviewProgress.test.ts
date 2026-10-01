import { describe, expect, it, vi } from "vitest";
import { observePreviewProgress } from "./observePreviewProgress";

function mediaFixture() {
  const events = new EventTarget();
  const state = { time: 10, bufferStart: 10, readyState: 2, buffered: true };
  const play = vi.fn();
  const pause = vi.fn();
  const video = Object.assign(events, {
    buffered: {
      get length() {
        return state.buffered ? 1 : 0;
      },
      start: () => state.bufferStart,
    },
    play,
    pause,
  });
  Object.defineProperties(video, {
    currentTime: {
      get: () => state.time,
      set: () => {
        throw new Error("进度观察不得修改播放时间");
      },
    },
    readyState: { get: () => state.readyState },
  });
  return { video: video as unknown as HTMLVideoElement, state, play, pause };
}

describe("回看进度的只读观察", () => {
  it("新回看首帧确认前不读取上一条流的缓冲和时间", () => {
    const { video, state } = mediaFixture();
    state.time = 100;
    let current = false;
    const report = vi.fn();
    const stop = observePreviewProgress(video, report, () => current);
    video.dispatchEvent(new Event("timeupdate"));
    expect(report).not.toHaveBeenCalled();
    state.bufferStart = 0;
    state.time = 0.25;
    video.dispatchEvent(new Event("loadedmetadata"));
    current = true;
    video.dispatchEvent(new Event("playing"));
    expect(report).toHaveBeenLastCalledWith(0.25);
    stop();
  });
  it("随媒体时间更新，暂停时不根据墙上时钟推进", () => {
    const { video, state, play, pause } = mediaFixture();
    const report = vi.fn();
    const stop = observePreviewProgress(video, report);
    state.time = 13.5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(report).toHaveBeenLastCalledWith(3.5);
    video.dispatchEvent(new Event("timeupdate"));
    expect(report).toHaveBeenLastCalledWith(3.5);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    stop();
  });

  it("原生控件往回跳时指示同步回退", () => {
    const { video, state } = mediaFixture();
    const report = vi.fn();
    const stop = observePreviewProgress(video, report);
    state.time = 20;
    video.dispatchEvent(new Event("timeupdate"));
    state.time = 12;
    video.dispatchEvent(new Event("seeked"));
    expect(report).toHaveBeenLastCalledWith(2);
    stop();
  });

  it("加载新源前忽略旧时间，缓冲清理后保留起始基准", () => {
    const { video, state } = mediaFixture();
    state.readyState = 0;
    const report = vi.fn();
    const stop = observePreviewProgress(video, report);
    video.dispatchEvent(new Event("timeupdate"));
    expect(report).not.toHaveBeenCalled();
    state.readyState = 2;
    state.bufferStart = 0;
    state.time = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(report).toHaveBeenLastCalledWith(1);
    state.bufferStart = 5;
    state.time = 8;
    video.dispatchEvent(new Event("timeupdate"));
    expect(report).toHaveBeenLastCalledWith(8);
    stop();
  });

  it("退出或换流后移除所有进度监听", () => {
    const { video } = mediaFixture();
    const report = vi.fn();
    const stop = observePreviewProgress(video, report);
    report.mockClear();
    stop();
    for (const type of [
      "loadedmetadata",
      "loadeddata",
      "playing",
      "timeupdate",
      "seeked",
    ]) {
      video.dispatchEvent(new Event(type));
    }
    expect(report).not.toHaveBeenCalled();
  });
});
