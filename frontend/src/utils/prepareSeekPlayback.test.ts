import { describe, expect, it, vi } from "vitest";
import { prepareSeekPlayback } from "./prepareSeekPlayback";
import { observePreviewProgress } from "./observePreviewProgress";

function fixture() {
  const state = { time: 100, start: 0, end: 0, seeking: false };
  const video = Object.assign(new EventTarget(), {
    pause: vi.fn(),
    buffered: {
      get length() { return state.end > state.start ? 1 : 0; },
      start: () => state.start,
      end: () => state.end,
    },
  });
  const writes: number[] = [];
  Object.defineProperties(video, {
    currentTime: { get: () => state.time, set: (value: number) => {
      writes.push(value); state.time = value; state.seeking = true;
    } },
    seeking: { get: () => state.seeking },
    readyState: { get: () => 2 },
  });
  const emit = (type: string) => video.dispatchEvent(new Event(type));
  const finishSeek = () => { state.seeking = false; emit("seeked"); };
  return { video: video as unknown as HTMLVideoElement, state, writes, emit, finishSeek };
}

describe("回看从解码关键帧定位到目标后起播", () => {
  it("目标60秒、关键帧24秒：定位完成后才播放和更新位置", () => {
    const { video, state, writes, emit, finishSeek } = fixture();
    let playing = false;
    const play = vi.fn(() => { playing = true; emit("playing"); });
    const report = vi.fn();
    const stopObserve = observePreviewProgress(video, (elapsed) => report(24 + elapsed), () => playing);
    const stop = prepareSeekPlayback(video, 60 - 24, play);
    state.time = 0; state.end = 10;
    emit("loadedmetadata"); emit("timeupdate");
    expect(writes).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    state.end = 40;
    emit("progress");
    expect(writes).toEqual([36]);
    emit("canplay");
    expect(play).not.toHaveBeenCalled();
    finishSeek();
    expect(play).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith(60);
    state.time = 37.5;
    emit("timeupdate");
    expect(report).toHaveBeenLastCalledWith(61.5);
    // 播放后原生控件回退不会再次被初始化定位拉回。
    state.time = 30; finishSeek();
    expect(writes).toEqual([36]);
    stop(); stopObserve();
  });

  it("非零媒体起点参与换算，不把录制时间直接写入currentTime", () => {
    const { video, state, writes, emit, finishSeek } = fixture();
    const play = vi.fn();
    const stop = prepareSeekPlayback(video, 36, play);
    state.start = 0.12; state.end = 40;
    emit("loadedmetadata");
    expect(writes[0]).toBeCloseTo(36.12);
    finishSeek();
    expect(play).toHaveBeenCalledOnce();
    stop();
  });

  it("目标就是关键帧且媒体已在起点时直接播放", () => {
    const { video, state, writes, emit } = fixture();
    const play = vi.fn();
    const stop = prepareSeekPlayback(video, 0, play);
    state.time = 0; state.end = 5;
    emit("loadedmetadata"); emit("canplay");
    expect(play).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    stop();
  });

  it("新元数据到达前忽略旧缓冲，代际失效后不定位或播放", () => {
    const { video, state, writes, emit } = fixture();
    state.end = 150;
    let current = true;
    const play = vi.fn();
    const stop = prepareSeekPlayback(video, 36, play, () => current);
    emit("progress");
    expect(writes).toEqual([]);
    current = false;
    emit("loadedmetadata"); emit("canplay");
    expect(writes).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    stop();
  });

  it("切源后移除监听，旧seeked不会触发播放", () => {
    const { video, state, emit, finishSeek } = fixture();
    const play = vi.fn();
    const stop = prepareSeekPlayback(video, 36, play);
    state.end = 40;
    emit("loadedmetadata");
    stop(); finishSeek(); emit("progress");
    expect(play).not.toHaveBeenCalled();
  });
});

describe("WebKit 守卫区与看狗", () => {
  function guardFixture(initialTime: number) {
    const state = { time: initialTime, start: 0, end: 0, seeking: false, rate: 1 };
    const video = Object.assign(new EventTarget(), {
      pause: vi.fn(),
      play: vi.fn(() => {
        state.time = Math.max(state.time, 1.05);
        video.dispatchEvent(new Event("timeupdate"));
        return Promise.resolve();
      }),
      buffered: {
        get length() { return state.end > state.start ? 1 : 0; },
        start: () => state.start,
        end: () => state.end,
      },
    });
    Object.defineProperty(video, "playbackRate", {
      get: () => state.rate,
      set: (v: number) => { state.rate = v; },
    });
    const writes: number[] = [];
    Object.defineProperties(video, {
      currentTime: { get: () => state.time, set: (value: number) => {
        writes.push(value); state.time = value; state.seeking = true;
      } },
      seeking: { get: () => state.seeking },
      readyState: { get: () => 2 },
    });
    const emit = (type: string) => video.dispatchEvent(new Event(type));
    return { video: video as unknown as HTMLVideoElement, state, writes, emit };
  }

  it("落点被内核劫持时倍速推过守卫区再定位", () => {
    const { video, state, writes, emit } = guardFixture(0.1);
    const onReady = vi.fn();
    const stop = prepareSeekPlayback(video, 0.8, onReady);
    state.end = 20;
    emit("loadedmetadata");
    // 常规直接定位先行（与既有语义一致）。
    expect(writes).toEqual([0.8]);
    // 内核劫持：seeked 回来落点被拉回 0.1。
    state.time = 0.1;
    state.seeking = false;
    emit("seeked");
    // 劫持恢复链同步走完：倍速推过守卫区→复速→再定位。
    expect(writes).toEqual([0.8, 0.8]);
    expect(video.playbackRate).toBe(1);
    state.seeking = false;
    emit("seeked");
    expect(onReady).toHaveBeenCalledOnce();
    stop();
  });

  it("看狗超时从缓冲起点放行并回调兑底", () => {
    vi.useFakeTimers();
    const { video, emit } = guardFixture(100);
    const onReady = vi.fn();
    const onFallback = vi.fn();
    const stop = prepareSeekPlayback(video, 36, onReady, () => true, onFallback, 8000);
    emit("loadedmetadata"); // buffer 空 → 永不覆盖
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8000);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledOnce();
    stop();
    vi.useRealTimers();
  });
});
