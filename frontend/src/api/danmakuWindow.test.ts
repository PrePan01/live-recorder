import { beforeEach, expect, it, vi } from 'vitest';
import { fetchDanmaku } from './danmaku';
import { fetchDanmakuWindow } from './danmakuWindow';
vi.mock('./danmaku', () => ({ fetchDanmaku: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('fetches every offset page including equal timestamps and sorts media time', async () => {
  vi.mocked(fetchDanmaku).mockResolvedValueOnce({ messages: [{ id: 'a', tMs: 1000, text: 'A' }], gaps: [], next: '100' })
    .mockResolvedValueOnce({ messages: [{ id: 'b', tMs: 1000, text: 'B' }, { id: 'c', tMs: 500, text: 'C' }], gaps: [], next: null });
  const controller = new AbortController();
  expect((await fetchDanmakuWindow('rec', 0, 30000, controller.signal)).messages.map(m => m.id)).toEqual(['c', 'a', 'b']);
  expect(fetchDanmaku).toHaveBeenLastCalledWith('rec', expect.objectContaining({ cursor: '100', fromMs: 0, toMs: 30000, signal: controller.signal }));
});
it('stops pagination when playback changes or a server repeats a cursor', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(fetchDanmakuWindow('rec', 0, 1000, controller.signal)).rejects.toThrow(); expect(fetchDanmaku).not.toHaveBeenCalled();
  vi.mocked(fetchDanmaku).mockResolvedValue({ messages: [], gaps: [], next: '100' });
  await expect(fetchDanmakuWindow('rec', 0, 1000, new AbortController().signal)).rejects.toThrow('cursor');
  expect(fetchDanmaku).toHaveBeenCalledTimes(2);
});
