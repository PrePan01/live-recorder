import { afterEach, expect, it, vi } from 'vitest';
import { useWallStore } from './wallStore';

it('moves into empty slots, preserves holes on removal and fills them on add', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a', 'b'], grid: '2x2' });
  useWallStore.getState().moveRoomToSlot('a', 3);
  expect(useWallStore.getState().roomIds).toEqual([null, 'b', null, 'a']);
  useWallStore.getState().addRooms(['c']);
  expect(useWallStore.getState().roomIds).toEqual(['c', 'b', null, 'a']);
  useWallStore.getState().removeRoom('b');
  expect(useWallStore.getState().roomIds).toEqual(['c', null, null, 'a']);
  useWallStore.getState().moveRoomToSlot('a', 0);
  expect(useWallStore.getState().roomIds).toEqual(['a', null, null, 'c']);
  useWallStore.getState().moveRoomToSlot('a', 4);
  expect(useWallStore.getState().roomIds).toEqual(['a', null, null, 'c']);
});

it('swaps only the requested rooms and ignores stale drag targets', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useWallStore.setState({ roomIds: ['a', 'b', 'c', 'd'] });
  useWallStore.getState().swapRooms('a', 'd');
  expect(useWallStore.getState().roomIds).toEqual(['d', 'b', 'c', 'a']);
  useWallStore.getState().swapRooms('missing', 'a');
  useWallStore.getState().swapRooms('b', 'b');
  expect(useWallStore.getState().roomIds).toEqual(['d', 'b', 'c', 'a']);
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
