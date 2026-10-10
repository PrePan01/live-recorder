import { expect, it } from 'vitest';
import { mergeLiveDanmakuWindow } from './liveDanmakuWindow';
const message = (id: string, tMs: number | null) => ({ id, tMs, text: id });
it('deduplicates incremental batches and bounds history when playback is paused', () => {
  const first = message('a', 1000), second = message('b', 2000);
  expect(mergeLiveDanmakuWindow([first], [first, second], 3000)).toEqual([first, second]);
  expect(mergeLiveDanmakuWindow([first, second], [], 32000)).toEqual([second]);
  const burst = Array.from({ length: 5000 }, (_, i) => message(String(i), 33000));
  expect(mergeLiveDanmakuWindow([], burst, 33000)).toHaveLength(2000);
  expect(mergeLiveDanmakuWindow([], burst, 33000)[0]!.id).toBe('3000');
});
it('keeps the array identity on idle or repeated batches so the renderer does not re-scan', () => {
  const first = message('a', 1000), previous = [first];
  expect(mergeLiveDanmakuWindow(previous, [], 2000)).toBe(previous);
  expect(mergeLiveDanmakuWindow(previous, [first], 2000)).toBe(previous);
  expect(mergeLiveDanmakuWindow(previous, [message('null', null), { ...message('unmapped', 2000), unmappable: true }], 2000)).toBe(previous);
});
