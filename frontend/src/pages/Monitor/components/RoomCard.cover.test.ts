import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomCard } from './RoomCard';
import type { Room } from '../../../types/room';
import type { Quality } from '../../../types/settings';

const preferences = vi.hoisted(() => ({ showLiveRoomCover: true }));
const coverSrc = vi.hoisted(() => vi.fn(() => '/test-live-cover'));
vi.mock('../../../stores/appearanceStore', () => ({
  useAppearanceStore: (select: (state: typeof preferences) => unknown) => select(preferences),
}));
vi.mock('../../../api/rooms', () => ({ liveCoverSrc: coverSrc, saveLiveCover: vi.fn() }));
vi.mock('./RoomAvatar', () => ({ default: () => null }));
vi.mock('./RoomStats', () => ({ default: () => null }));
vi.mock('./RoomHealth', () => ({ default: () => null }));
vi.mock('./LivePredictionBadge', () => ({ default: () => null }));

const room = {
  id: 'cover-room', displayName: '主播', platform: 'bilibili',
  lastLiveStatus: 'live', monitorState: 'idle', availableQualities: [],
  tags: [], liveCoverUrl: 'https://cdn.example.com/cover.jpg',
} as unknown as Room;
const noop = () => undefined;
const render = (
  currentRoom = room,
  layout: 'card' | 'list' = 'card',
  autoRecordEnabled = false,
  defaultQuality: Quality | null = null,
) => renderToStaticMarkup(
  createElement(MemoryRouter, null, createElement(RoomCard, {
    room: currentRoom, layout, onManageRoom: noop, onWatch: noop, onCheck: noop,
    selectedTagIds: [], onToggleTagFilter: noop,
    onStop: noop, onRecord: noop, onFavorite: noop, onEnableFloating: noop,
    autoRecordEnabled, defaultQuality, bilibiliAuthorized: true,
    floatingEnabled: false, floatingReady: true,
  })),
);

beforeEach(() => { coverSrc.mockClear(); preferences.showLiveRoomCover = true; });

it('compares Bilibili availability with the effective room quality, then the room or global fallback', () => {
  const available: Room = { ...room, availableQualities: ['720p'] };
  const effective: NonNullable<Room['effective']> = {
    quality: { value: '720p', source: 'global' },
    checkIntervalSec: { value: 60, source: 'global' },
    autoRecord: { value: false, source: 'global' },
    danmakuEnabled: { value: false, source: 'global' },
  };
  const warning = '当前最高可观看、录制';
  expect(render({ ...available, quality: null, effective }, 'card', false, 'original')).not.toContain(warning);
  expect(render({ ...available, quality: '720p' }, 'card', false, 'original')).not.toContain(warning);
  expect(render({ ...available, quality: '1080p' }, 'card', false, '720p')).toContain(warning);
  expect(render(available, 'card', false, 'original')).toContain(warning);
});

it('offers copying the current stream title on live cards with a title', () => {
  const currentRoom = { ...room, currentStreamTitle: '  今晚直播 🎙️  ' };
  expect(render(currentRoom)).toMatch(/<button[^>]*aria-label="复制直播标题：今晚直播 🎙️"/);
  expect(render({ ...currentRoom, lastLiveStatus: 'offline' })).not.toContain('复制直播标题');
  const untitled = render({ ...currentRoom, currentStreamTitle: ' ' });
  expect(untitled).toContain('直播标题暂未获取');
  expect(untitled).not.toContain('复制直播标题');
});

it('renders a cover image request for live cards when enabled', () => {
  expect(render()).toContain('src="/test-live-cover"');
  expect(coverSrc).toHaveBeenCalledWith(room.id, room.liveCoverUrl);
});

it('omits the cover component and image request when disabled', () => {
  preferences.showLiveRoomCover = false;
  expect(render()).not.toContain('lr-room-cover');
  expect(coverSrc).not.toHaveBeenCalled();
});

it('continues to omit covers for offline rooms and list rows', () => {
  expect(render({ ...room, lastLiveStatus: 'offline' })).not.toContain('lr-room-cover');
  expect(render(room, 'list')).not.toContain('lr-room-cover');
  expect(coverSrc).not.toHaveBeenCalled();
});

it.each(['card', 'list'] as const)('shows enabled plan tags alongside automatic recording in %s layout', (layout) => {
  const enabled = render({ ...room, enabledPlans: { schedule: true, keyword: true } }, layout, true);
  expect(enabled).toContain('自动录制');
  expect(enabled).toContain('定时计划');
  expect(enabled).toContain('关键词计划');

  const scheduleOnly = render({ ...room, enabledPlans: { schedule: true, keyword: false } }, layout);
  expect(scheduleOnly).toContain('定时计划');
  expect(scheduleOnly).not.toContain('关键词计划');
  expect(render(room, layout)).not.toContain('定时计划');
});
