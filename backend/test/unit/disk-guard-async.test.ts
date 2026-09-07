import { afterEach, expect, it, vi } from 'vitest';
import { statfs } from 'node:fs/promises';
import { FakeDiskGuard } from '../../src/storage/disk-guard.js';
vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
it('bounds an unavailable filesystem check without blocking the local service', async () => {
  vi.useFakeTimers();
  vi.mocked(statfs).mockReturnValue(new Promise(() => {}));
  const guard = new FakeDiskGuard();
  const first = guard.inspect('/unavailable-share');
  expect(guard.inspect('/unavailable-share')).toBe(first);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await first).toEqual({ freeBytes: 0, totalBytes: 0 });
});
