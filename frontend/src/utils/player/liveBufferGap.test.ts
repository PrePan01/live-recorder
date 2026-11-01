import { expect, it } from 'vitest';
import { liveBufferGapTarget } from './liveBufferGap';

function video(time: number, ranges: number[][], overrides = {}) {
  return { currentTime: time, readyState: 2, paused: false, seeking: false, ended: false,
    buffered: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] },
    ...overrides,
  } as HTMLVideoElement;
}

it('bridges a small initial gap or a discontinuity into playable buffered media', () => {
  expect(liveBufferGapTarget(video(0, [[0.1, 3]]))).toBeCloseTo(0.15);
  expect(liveBufferGapTarget(video(2, [[0, 2], [2.2, 5]]))).toBeCloseTo(2.25);
  expect(liveBufferGapTarget(video(1.98, [[0, 2], [2.2, 5]]))).toBeCloseTo(2.25);
});

it.each([
  video(1, [[0, 5]]), // Contiguous playable data: do not mask a decoder failure.
  video(2, [[0, 2], [3, 5]]), // Do not skip large missing content.
  video(2, [[0, 2], [2.1, 2.2]]), // Too little media to resume safely.
  video(2, []),
  video(2, [[2.1, 5]], { paused: true }),
  video(2, [[2.1, 5]], { seeking: true }),
  video(2, [[2.1, 5]], { ended: true }),
  video(2, [[2.1, 5]], { readyState: 0 }),
])('does not seek when playback or buffer conditions are unsuitable (%#)', video => {
  expect(liveBufferGapTarget(video)).toBeNull();
});
