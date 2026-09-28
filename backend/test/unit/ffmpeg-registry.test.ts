import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  installFfmpegExitReap,
  reapTrackedFfmpegs,
  trackFfmpeg,
  trackedFfmpegCount,
} from '../../src/recorder/ffmpeg-registry.js';

describe('ffmpeg 进程收割', () => {
  it('优雅收束时收割登记的子进程：SIGTERM → 宽限 → 全部退出，登记清空', async () => {
    installFfmpegExitReap(); // 幂等
    installFfmpegExitReap();
    const a = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    trackFfmpeg(a);
    trackFfmpeg(b);
    expect(trackedFfmpegCount()).toBe(2);

    const reaped = await reapTrackedFfmpegs(3_000);
    expect(reaped).toBe(2);
    expect(a.signalCode === 'SIGTERM' || a.exitCode !== null).toBe(true);
    expect(b.signalCode === 'SIGTERM' || b.exitCode !== null).toBe(true);
    expect(trackedFfmpegCount()).toBe(0);
    // 幂等：空表再收割为 0。
    expect(await reapTrackedFfmpegs(100)).toBe(0);
  });
});
