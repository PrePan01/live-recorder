import { describe, expect, it, vi } from 'vitest';
import { MediaWorkQueue } from '../../src/recorder/media-work-queue.js';

describe('media work budget', () => {
  it('bounds execution, releases failed slots and removes cancelled waiting jobs', async () => {
    const queue = new MediaWorkQueue(1);
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const abort = new AbortController();
    let cancelledStarted = false;
    const cancelled = queue.run(async () => { cancelledStarted = true; }, abort.signal);
    const cancelledCheck = expect(cancelled).rejects.toThrow('cancelled');
    abort.abort();
    let nextStarted = false;
    const next = queue.run(async () => { nextStarted = true; throw new Error('failed'); });
    const failedCheck = expect(next).rejects.toThrow('failed');
    expect(nextStarted).toBe(false);
    release();
    await first;
    await cancelledCheck;
    await failedCheck;
    expect(cancelledStarted).toBe(false);
    expect(nextStarted).toBe(true);
    await expect(queue.run(async () => 'reused')).resolves.toBe('reused');
  });

  it('keeps queued work alive without masking a stalled process after dispatch', async () => {
    vi.useFakeTimers();
    try {
      const queue = new MediaWorkQueue(1);
      let release!: () => void;
      const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
      await Promise.resolve();
      const heartbeat = vi.fn();
      let finish!: () => void;
      const second = queue.run(() => new Promise<void>(resolve => { finish = resolve; }), undefined, heartbeat);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      release();
      await first;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      finish();
      await second;
    } finally { vi.useRealTimers(); }
  });
});
