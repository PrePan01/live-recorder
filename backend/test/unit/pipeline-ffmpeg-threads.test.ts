import { describe, expect, it } from 'vitest';
import { ffmpegThreadCount } from '../../src/recorder/pipeline-ffmpeg.js';

describe('ffmpeg thread limit', () => {
  it('uses at least one and no more than four or half the logical cores', () => {
    expect(ffmpegThreadCount(1)).toBe(1);
    expect(ffmpegThreadCount(2)).toBe(1);
    expect(ffmpegThreadCount(8)).toBe(4);
    expect(ffmpegThreadCount(64)).toBe(4);
  });
});
