import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ run: vi.fn(), fingerprint: 0 }));
vi.mock('../../src/recorder/pipeline-ffmpeg.js', () => ({ runFfmpeg: mock.run }));
vi.mock('../../src/utils/ffmpeg.js', () => ({ resolveBin: () => `/nonexistent-ffmpeg-${mock.fingerprint}` }));
import { detectHwEncoder, encodeWithFallback } from '../../src/recorder/hw-encode.js';
// These platforms have a supported candidate; no local hardware is used by this test.
const supported = process.platform === 'darwin' || process.platform === 'win32';
beforeEach(() => { mock.run.mockReset().mockResolvedValue({ ok: true }); mock.fingerprint++; });
it.skipIf(!supported)('shares concurrent hardware probes and caches by executable identity', async () => {
  const path = `/nonexistent-ffmpeg-${mock.fingerprint}`;
  const results = await Promise.all(Array.from({ length: 12 }, () => detectHwEncoder(path)));
  expect(results.every(value => value === results[0] && value !== null)).toBe(true);
  expect(mock.run).toHaveBeenCalledTimes(1);
  await detectHwEncoder(path); expect(mock.run).toHaveBeenCalledTimes(1);
});
it.skipIf(!supported)('retries hardware failure once with superfast software and publishes each active encoder', async () => {
  const attempts: string[] = [], statuses: unknown[] = [];
  const out = await encodeWithFallback({ mode: 'auto', crf: 23, preset: 'superfast', onEncoder: status => statuses.push(status),
    attempt: async (encoder, args) => {
      attempts.push(encoder);
      if (encoder !== 'libx264') return '产物校验失败';
      expect(args).toEqual(['-c:v', 'libx264', '-crf', '23', '-preset', 'superfast']); return null;
    },
  });
  expect(attempts).toHaveLength(2);
  expect(statuses).toEqual([{ actualEncoder: attempts[0], fallbackReason: null }, { actualEncoder: 'libx264', fallbackReason: '产物校验失败' }]);
  expect(out).toEqual({ actualEncoder: 'libx264', fallbackReason: '产物校验失败' });
});
it.skipIf(!supported)('does not fall back when cancelled during the hardware attempt', async () => {
  let cancelled = false;
  const attempt = vi.fn(async () => { cancelled = true; return '中途失败' as const; });
  await encodeWithFallback({ mode: 'auto', crf: 23, isCancelled: () => cancelled, attempt });
  expect(attempt).toHaveBeenCalledTimes(1);
});
it.skipIf(!supported)('cancels a probe wait without cancelling another task sharing that probe', async () => {
  let finish!: (result: { ok: boolean }) => void;
  mock.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const attempt = vi.fn(async () => null);
  const job = encodeWithFallback({ mode: 'auto', crf: 23, signal: controller.signal, isCancelled: () => controller.signal.aborted, attempt });
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalledTimes(1));
  const shared = detectHwEncoder(`/nonexistent-ffmpeg-${mock.fingerprint}`);
  controller.abort(); await expect(job).rejects.toThrow('cancelled'); expect(attempt).not.toHaveBeenCalled();
  finish({ ok: true }); expect(await shared).not.toBeNull(); expect(mock.run).toHaveBeenCalledTimes(1);
});
