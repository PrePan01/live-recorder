import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void>,
  players: [] as Array<{ destroy: ReturnType<typeof vi.fn>; error?: () => void }>,
  message: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = value;
    return [h.slots[i], (next: unknown) => { h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next; }];
  },
  useRef: (value: unknown) => h.slots[h.cursor++] ??= { current: value },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const i = h.cursor++;
    const old = h.slots[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) h.slots[i] = { fn, deps };
    return (h.slots[i] as { fn: unknown }).fn;
  },
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = h.cursor++;
    const old = h.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) h.effects.push(() => {
      old?.cleanup?.(); h.slots[i] = { deps, cleanup: fn() };
    });
  },
}));
vi.mock('antd', () => ({ App: { useApp: () => ({ message: h.message }) }, Button: 'button', Modal: 'modal', Select: 'select', Typography: { Text: 'text' } }));
vi.mock('@ant-design/icons', () => ({ PauseOutlined: 'pause', CaretRightOutlined: 'play', ExportOutlined: 'export', SoundOutlined: 'sound', MutedOutlined: 'mute' }));
vi.mock('mpegts.js', () => ({ default: {
  Events: { ERROR: 'error' },
  createPlayer: () => {
    const player = { destroy: vi.fn(), error: undefined as undefined | (() => void),
      attachMediaElement: vi.fn(), load: vi.fn(), on: (_event: string, error: () => void) => { player.error = error; } };
    h.players.push(player); return player;
  },
} }));
vi.mock('../api/recordings', () => ({
  recordingFileUrl: () => '/file', fetchRecordingPosition: vi.fn(),
  fetchRecordingMarkers: async () => [], fetchRecordingGaps: async () => [],
  createRecordingMarker: vi.fn(), deleteRecordingMarker: vi.fn(), updateRecordingMarker: vi.fn(),
}));
vi.mock('../api/danmakuWindow', () => ({ fetchDanmakuWindow: async () => ({ messages: [], gaps: [] }) }));
vi.mock('../api/danmaku', () => ({ exportDanmaku: vi.fn() }));
vi.mock('../api/config', () => ({ pickDirectory: vi.fn() }));
vi.mock('../utils/promptRangeExport', () => ({ promptRangeExport: vi.fn() }));
vi.mock('../hooks/useSegmentMarking', () => ({ useSegmentMarking: () => ({ start: null }) }));
vi.mock('../hooks/useSegmentExport', () => ({ useSegmentExport: () => ({}) }));
vi.mock('../stores/danmakuPrefsStore', () => ({ useDanmakuPrefsStore: () => ({ visible: true, opacity: 1, density: 100, fontScale: 1, speedMultiplier: 1 }) }));
vi.mock('./SegmentExportActions', () => ({ SegmentExportActions: 'export-actions' }));
vi.mock('./SegmentMarkActions', () => ({ SegmentMarkActions: 'mark-actions' }));
vi.mock('./DanmakuLayer', () => ({ DanmakuLayer: 'danmaku' }));
vi.mock('./RecordingTrack', () => ({ default: 'track' }));
vi.mock('./MarkerNavPanel', () => ({ MarkerNavPanel: 'markers' }));
vi.mock('./DanmakuSettings', () => ({ default: 'settings' }));
import { DanmakuPlayerModal } from './DanmakuPlayerModal';
import { fetchRecordingPosition } from '../api/recordings';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}
const props = { recordingId: 'rec', platform: 'youtube', filePath: 'original.mkv', title: 'Live', durationSeconds: 999, onClose: vi.fn() };
function render() {
  h.cursor = 0; h.effects = [];
  const tree = elements(DanmakuPlayerModal(props));
  h.effects.splice(0).forEach(effect => effect());
  return {
    video: tree.find(el => el.type === 'video')!,
    track: tree.find(el => el.type === 'track')!.props as unknown as {
      elapsedSeconds: number; previewSecond: number; previewLoading: boolean; quickAddDisabled: boolean;
      onSeekCommit: (second: number) => void; getMarkerPosition: () => Promise<number>;
    },
    danmaku: tree.find(el => el.type === 'danmaku')!.props as unknown as { getTimeMs: () => number },
    markers: tree.find(el => el.type === 'markers')!.props as unknown as { onPreview: (marker: { positionSeconds: number; endPositionSeconds: number }) => void },
    failed: tree.some(el => el.props.role === 'alert'),
  };
}
const video = () => ({ readyState: 2, seeking: false, currentTime: 1, paused: true, ended: false, duration: 20,
  buffered: { length: 1, start: () => 1 }, volume: 1, muted: false, playbackRate: 1,
  play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(),
}) as unknown as HTMLVideoElement;
function mount(tree: ReturnType<typeof render>, element: HTMLVideoElement) {
  (tree.video.props.ref as (element: HTMLVideoElement) => void)(element);
  return render();
}
function event(tree: ReturnType<typeof render>, name: string, element: HTMLVideoElement) {
  (tree.video.props[name] as (event: { currentTarget: HTMLVideoElement }) => void)({ currentTarget: element });
}
beforeEach(() => {
  h.slots = []; h.players = []; vi.clearAllMocks();
  vi.useFakeTimers(); vi.stubGlobal('window', { setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(fetchRecordingPosition).mockResolvedValue({ durationSeconds: 300, positionSeconds: 300, previewOffsetSeconds: null });
});
afterEach(() => {
  for (const slot of h.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('YouTube history playback source transitions', () => {
  it('uses file duration and rejects retired frames/errors/marker positions across a seek', async () => {
    const oldVideo = video();
    let tree = mount(render(), oldVideo);
    const oldPlayer = h.players[0];
    await Promise.resolve();
    event(tree, 'onCanPlay', oldVideo);
    tree = render();
    expect(tree.track.elapsedSeconds).toBe(300); // neither wall-time hint 999 nor stream duration 20
    expect(await tree.track.getMarkerPosition()).toBe(0);
    oldVideo.volume = 0.4; oldVideo.muted = true; oldVideo.playbackRate = 1.5;
    event(tree, 'onVolumeChange', oldVideo);
    event(tree, 'onRateChange', oldVideo);
    tree = render();
    const oldTree = tree;
    tree.track.onSeekCommit(120);
    await expect(oldTree.track.getMarkerPosition()).rejects.toThrow('画面尚未就绪');
    event(oldTree, 'onError', oldVideo);
    tree = render();
    expect(tree.track.quickAddDisabled).toBe(true);
    expect(tree.failed).toBe(false);
    const newVideo = video();
    tree = mount(tree, newVideo);
    expect([newVideo.volume, newVideo.muted, newVideo.playbackRate]).toEqual([0.4, true, 1.5]);
    oldPlayer.error?.();
    event(oldTree, 'onCanPlay', oldVideo);
    event(tree, 'onCanPlay', newVideo);
    newVideo.currentTime = 3;
    event(tree, 'onTimeUpdate', newVideo);
    tree = render();
    expect(tree.failed).toBe(false);
    expect(tree.track.quickAddDisabled).toBe(false);
    expect(tree.track.previewSecond).toBe(122);
    expect(await tree.track.getMarkerPosition()).toBe(122);
    expect(tree.danmaku.getTimeMs()).toBe(122000);
    expect(newVideo.play).not.toHaveBeenCalled(); // manual seek preserves pause
  });
  it('starts a selected segment on the new source even when the previous video was paused', () => {
    const oldVideo = video();
    let tree = mount(render(), oldVideo);
    event(tree, 'onCanPlay', oldVideo);
    tree = render();
    tree.markers.onPreview({ positionSeconds: 60, endPositionSeconds: 65 });
    tree = render();
    const newVideo = video();
    tree = mount(tree, newVideo);
    event(tree, 'onCanPlay', newVideo);
    expect(newVideo.play).toHaveBeenCalledOnce();
    newVideo.currentTime = 7;
    event(tree, 'onTimeUpdate', newVideo);
    expect(newVideo.pause).toHaveBeenCalledOnce();
    expect(render().track.previewSecond).toBe(65);
  });
});
