import { afterEach, describe, expect, it, vi } from 'vitest';
import { DanmakuPlayback, danmakuPlaybackRate } from './danmakuPlayback';

class Video extends EventTarget {
  paused = false;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  signal(event: string) { this.dispatchEvent(new Event(event)); }
}
function setup() {
  const video = new Video();
  const notify = vi.fn();
  const playback = new DanmakuPlayback(() => video as unknown as HTMLVideoElement, notify);
  playback.sample();
  return { video, playback, notify };
}
afterEach(() => { vi.useRealTimers(); });

describe('弹幕媒体状态同步', () => {
  it('短暂丢失未来数据不会暂停；暂停、跳播、结束和未就绪立即停止', () => {
    const { video, playback } = setup();
    video.readyState = 2; expect(playback.sample()).toBe(1);
    video.paused = true; expect(playback.sample()).toBe(0);
    video.paused = false; video.seeking = true; expect(playback.sample()).toBe(0);
    video.seeking = false; video.ended = true; expect(playback.sample()).toBe(0);
    video.ended = false; video.readyState = 1; expect(playback.sample()).toBe(0);
    expect(danmakuPlaybackRate(null)).toBe(0);
    playback.destroy();
  });
  it('反复的短 waiting/playing 波动不会产生停顿', () => {
    vi.useFakeTimers();
    const { video, playback, notify } = setup();
    for (let i = 0; i < 20; i++) {
      video.readyState = 2; video.signal('waiting'); vi.advanceTimersByTime(100);
      expect(playback.sample()).toBe(1);
      video.readyState = 4; video.signal('playing'); vi.advanceTimersByTime(100);
      expect(playback.sample()).toBe(1);
    }
    expect(notify).toHaveBeenCalledTimes(20);
    playback.destroy();
  });
  it('持续等待超过宽限后暂停，恢复立即继续', () => {
    vi.useFakeTimers();
    const { video, playback, notify } = setup();
    video.signal('waiting'); vi.advanceTimersByTime(179);
    expect(playback.sample()).toBe(1);
    vi.advanceTimersByTime(1); expect(playback.sample()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    video.signal('playing'); expect(playback.sample()).toBe(1);
    playback.destroy();
  });
  it('播放、暂停、跳播及倍速事件立即通知，销毁解除监听与等待计时器', () => {
    vi.useFakeTimers();
    const { video, playback, notify } = setup();
    video.paused = true; video.signal('pause'); expect(notify).toHaveBeenCalledTimes(1);
    video.paused = false; video.playbackRate = 2; video.signal('ratechange');
    expect(playback.sample()).toBe(2);
    video.signal('waiting'); playback.destroy();
    vi.advanceTimersByTime(1000); video.signal('playing'); video.signal('pause');
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('更换视频元素不会遗留旧事件监听、缓冲状态或计时器', () => {
    vi.useFakeTimers();
    const old = new Video(); const next = new Video(); next.playbackRate = 1.5;
    let current = old; const notify = vi.fn();
    const playback = new DanmakuPlayback(() => current as unknown as HTMLVideoElement, notify);
    playback.sample(); old.signal('waiting'); current = next;
    expect(playback.sample()).toBe(1.5);
    vi.advanceTimersByTime(1000); old.signal('pause'); expect(notify).not.toHaveBeenCalled();
    next.signal('ratechange'); expect(notify).toHaveBeenCalledTimes(1);
    playback.destroy();
  });
});
