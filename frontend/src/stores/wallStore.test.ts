import { afterEach, expect, it, vi } from 'vitest';
import {
  applyAddRooms,
  applyGridLayout,
  getWallCapacity,
  getWallLayout,
  useWallStore,
} from './wallStore';

it('moves between slots, preserves holes on removal and fills them on add', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a', 'b'], grid: '2x2' });
  useWallStore.getState().swapSlots(0, 3);
  expect(useWallStore.getState().roomIds).toEqual([null, 'b', null, 'a']);
  useWallStore.getState().addRooms(['c']);
  expect(useWallStore.getState().roomIds).toEqual(['c', 'b', null, 'a']);
  useWallStore.getState().removeSlot(1);
  expect(useWallStore.getState().roomIds).toEqual(['c', null, null, 'a']);
  useWallStore.getState().swapSlots(3, 0);
  expect(useWallStore.getState().roomIds).toEqual(['a', null, null, 'c']);
  useWallStore.getState().swapSlots(0, 4);
  expect(useWallStore.getState().roomIds).toEqual(['a', null, null, 'c']);
});

it('swaps only the requested slots and ignores out-of-range or self targets', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a', 'b', 'c', 'd'], grid: '2x2' });
  useWallStore.getState().swapSlots(0, 3);
  expect(useWallStore.getState().roomIds).toEqual(['d', 'b', 'c', 'a']);
  useWallStore.getState().swapSlots(-1, 0);
  useWallStore.getState().swapSlots(1, 1);
  useWallStore.getState().swapSlots(0, 9);
  expect(useWallStore.getState().roomIds).toEqual(['d', 'b', 'c', 'a']);
});

it('adds a room directly into the selected empty slot', () => {
  useWallStore.setState({ roomIds: ['a', null, null, 'd'], grid: '2x2' });
  expect(useWallStore.getState().addRoomToSlot('b', 2)).toBe(true);
  expect(useWallStore.getState().roomIds).toEqual(['a', null, 'b', 'd']);
  expect(useWallStore.getState().addRoomToSlot('a', 1)).toBe(false);
  expect(useWallStore.getState().addRoomToSlot('c', 2)).toBe(false);
  expect(useWallStore.getState().addRoomToSlot('c', 4)).toBe(false);
});

afterEach(() => {
  useWallStore.setState({ roomIds: [], grid: '2x2' });
  vi.restoreAllMocks();
});

it('uses the selected grid capacity and removes off-grid rooms when reducing the layout', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['1', '2', '3', '4'], grid: '2x2' });
  expect(useWallStore.getState().addRooms(['5']).added).toEqual([]);

  useWallStore.getState().setGrid('3x3');
  const result = useWallStore.getState().addRooms(['4', '5', '6', '7', '8', '9', '10']);
  expect(result.added).toEqual(['5', '6', '7', '8', '9']);
  expect(result.dropped).toEqual(['10']);
  expect(useWallStore.getState().roomIds).toHaveLength(9);

  useWallStore.getState().setGrid('2x2');
  expect(useWallStore.getState().roomIds).toEqual(['1', '2', '3', '4']);
  expect(useWallStore.getState().addRooms(['10']).added).toEqual([]);

  useWallStore.getState().setGrid('3x3');
  expect(useWallStore.getState().roomIds).toEqual(['1', '2', '3', '4']);
});

it('describes each layout, with only the portrait one filling height and allowing repeats', () => {
  expect(getWallLayout('2x2')).toEqual({ columns: 2, rows: 2, fill: false, allowDuplicates: false });
  expect(getWallLayout('3x3')).toEqual({ columns: 3, rows: 3, fill: false, allowDuplicates: false });
  expect(getWallLayout('3x1')).toEqual({ columns: 3, rows: 1, fill: true, allowDuplicates: true });
});

it('keeps only the first row when switching to the portrait layout', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['1', '2', '3', '4', '5'], grid: '3x3' });

  expect(getWallCapacity('3x1')).toBe(3);

  useWallStore.getState().setGrid('3x1');
  expect(useWallStore.getState().roomIds).toEqual(['1', '2', '3']);
  expect(useWallStore.getState().addRooms(['4'])).toEqual({
    nextIds: ['1', '2', '3'],
    added: [],
    dropped: ['4'],
  });

  useWallStore.getState().setGrid('3x1');
  expect(useWallStore.getState().roomIds).toEqual(['1', '2', '3']);

  useWallStore.getState().setGrid('2x2');
  expect(useWallStore.getState().addRooms(['4']).added).toEqual(['4']);
});

it('lets the portrait layout hold one room in several slots', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: [], grid: '3x1' });
  useWallStore.getState().addRooms(['a']);
  useWallStore.getState().addRooms(['a']);
  expect(useWallStore.getState().roomIds).toEqual(['a', 'a']);

  expect(useWallStore.getState().addRoomToSlot('a', 2)).toBe(true);
  expect(useWallStore.getState().roomIds).toEqual(['a', 'a', 'a']);

  // 移除一格不能把其它格子上的同一路一起带走。
  useWallStore.getState().removeSlot(0);
  expect(useWallStore.getState().roomIds).toEqual([null, 'a', 'a']);
});

it('refuses duplicates in every layout except the portrait one', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a'], grid: '2x2' });
  expect(useWallStore.getState().addRooms(['a']).added).toEqual([]);
  expect(useWallStore.getState().addRoomToSlot('a', 1)).toBe(false);

  useWallStore.setState({ roomIds: ['a'], grid: '3x3' });
  expect(useWallStore.getState().addRooms(['a']).added).toEqual([]);

  // 同一批里的重复项在禁止重复的布局下也只收一次。
  expect(applyAddRooms([], ['a', 'a'], 4, false).added).toEqual(['a']);
  expect(applyAddRooms([], ['a', 'a'], 4, true).added).toEqual(['a', 'a']);
});

it('drops repeated rooms when leaving the portrait layout', () => {
  expect(applyGridLayout(['a', 'a', 'b'], '3x1')).toEqual(['a', 'a', 'b']);
  expect(applyGridLayout(['a', 'a', 'b'], '2x2')).toEqual(['a', null, 'b']);

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a', 'a', 'b'], grid: '3x1' });
  useWallStore.getState().setGrid('2x2');
  expect(useWallStore.getState().roomIds).toEqual(['a', null, 'b']);

  // 去重后该房间回到「已在墙上」，不能再加；空出来的槽位留给别的房间。
  expect(useWallStore.getState().addRooms(['a']).added).toEqual([]);
  expect(useWallStore.getState().addRooms(['c'])).toEqual({
    nextIds: ['a', 'c', 'b'],
    added: ['c'],
    dropped: [],
  });
});
