import { describe, expect, it } from "vitest";
import { FilePlaybackClock } from "./filePlaybackClock";

function video() {
  let start = 0.08;
  const media = { readyState: 2, seeking: false, currentTime: 0.08,
    buffered: { length: 1, start: () => start } } as unknown as HTMLVideoElement;
  return { media, trim: (second: number) => { start = second; } };
}

describe("compatible file source clock", () => {
  it("invalidates the old picture before a seek commits and rejects late frames from superseded seeks", () => {
    const clock = new FilePlaybackClock(30);
    const old = video().media;
    clock.attach(old, 0);
    expect(clock.read(old)).toBeUndefined();
    expect(clock.present(old, 0)).toBe(true);
    old.currentTime = 8.08;
    expect(clock.read(old)).toBeCloseTo(38);
    const first = clock.begin(100);
    expect(clock.read(old)).toBeUndefined();
    expect(clock.present(old, 0)).toBe(false);
    const next = video().media;
    clock.attach(next, first);
    const second = clock.begin(200);
    expect(clock.present(next, first)).toBe(false);
    expect(clock.attach(old, first)).toBe(false);
    const current = video().media;
    clock.attach(current, second);
    expect(clock.present(current, second)).toBe(true);
    expect(clock.read(current)).toBe(200);
    current.currentTime = 2.33;
    expect(clock.read(current)).toBeCloseTo(202.25);
  });

  it("keeps marker, progress and danmaku positions stable when old buffers are discarded", () => {
    const clock = new FilePlaybackClock(60);
    const { media, trim } = video();
    clock.attach(media, 0);
    clock.present(media, 0);
    media.currentTime = 45.08;
    trim(30);
    expect(clock.read(media)).toBeCloseTo(105);
    expect(clock.present(media, 0)).toBe(true);
    expect(clock.read(media)).toBeCloseTo(105);
    Object.defineProperty(media, 'seeking', { value: true, configurable: true });
    expect(clock.read(media)).toBeUndefined();
    Object.defineProperty(media, 'seeking', { value: false, configurable: true });
    expect(clock.read(media)).toBeCloseTo(105);
  });
});
