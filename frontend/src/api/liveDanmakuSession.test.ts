import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLiveDanmakuSession } from './liveDanmakuSession';
import { readLiveDanmaku, subscribeLiveDanmaku, unsubscribeLiveDanmaku, type LiveDanmakuSnapshot } from './danmaku';
import { ApiError } from '../types/error';
vi.mock('./danmaku', () => ({ readLiveDanmaku: vi.fn(), subscribeLiveDanmaku: vi.fn(), unsubscribeLiveDanmaku: vi.fn() }));
const snapshot: LiveDanmakuSnapshot = { messages: [], cursor: 123, generation: 'initial', mediaNowMs: 1000, status: { recordingId: 'preview', state: 'collecting', since: 0 } };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.mocked(subscribeLiveDanmaku).mockResolvedValue(snapshot);
  vi.mocked(readLiveDanmaku).mockResolvedValue({ ...snapshot, cursor: 124 });
  vi.mocked(unsubscribeLiveDanmaku).mockResolvedValue();
});
afterEach(() => vi.useRealTimers());
it('uses one lease with sequential cursor reads and closes its timer and subscription', async () => {
  const apply = vi.fn(), fail = vi.fn();
  const stop = createLiveDanmakuSession('room', apply, fail);
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledWith(snapshot);
  const [, token, signal] = vi.mocked(subscribeLiveDanmaku).mock.calls[0]!;
  await vi.advanceTimersByTimeAsync(1000);
  expect(readLiveDanmaku).toHaveBeenCalledWith('room', token, 123, signal);
  stop(); stop(); expect(signal.aborted).toBe(true);
  expect(unsubscribeLiveDanmaku).toHaveBeenCalledExactlyOnceWith('room', token);
  await vi.advanceTimersByTimeAsync(10000);
  expect(readLiveDanmaku).toHaveBeenCalledTimes(1);
});
it('releases a canceled in-flight start and discards its late response', async () => {
  let resolve!: (data: LiveDanmakuSnapshot) => void;
  vi.mocked(subscribeLiveDanmaku).mockReturnValue(new Promise(r => { resolve = r; }));
  const apply = vi.fn();
  const stop = createLiveDanmakuSession('room', apply, vi.fn());
  stop(); resolve(snapshot); await vi.advanceTimersByTimeAsync(5000);
  expect(apply).not.toHaveBeenCalled(); expect(readLiveDanmaku).not.toHaveBeenCalled();
  expect(unsubscribeLiveDanmaku).toHaveBeenCalledTimes(1);
});
it('does not overlap slow requests and re-subscribes after lease expiry', async () => {
  let resolve!: (data: LiveDanmakuSnapshot) => void;
  vi.mocked(readLiveDanmaku).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const failure = vi.fn();
  const stop = createLiveDanmakuSession('room', vi.fn(), failure);
  await vi.advanceTimersByTimeAsync(10000);
  expect(readLiveDanmaku).toHaveBeenCalledTimes(1);
  resolve({ ...snapshot, cursor: 125 }); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(readLiveDanmaku).mockRejectedValueOnce(new ApiError({ code: 'RESOURCE_NOT_FOUND', message: 'expired', occurredAt: '', retryable: true }));
  await vi.advanceTimersByTimeAsync(1000); expect(failure).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); expect(subscribeLiveDanmaku).toHaveBeenCalledTimes(2);
  stop();
});
