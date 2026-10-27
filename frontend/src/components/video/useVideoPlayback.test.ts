import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { VideoPlayerProps } from "./types";

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  ready: null as (() => void) | null,
  frame: null as (() => void) | null,
  players: [] as { load: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; attachMediaElement: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[],
}));
vi.mock("react", () => {
  const changed = (a: unknown[] | undefined, b: unknown[]) => !a || a.length !== b.length || b.some((v, i) => !Object.is(v, a[i]));
  return {
    useRef: (value: unknown) => h.slots[h.cursor++] ??= { current: value },
    useState: (value: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = value;
      return [h.slots[i], (next: unknown) => { h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next; }];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = h.cursor++;
      const old = h.slots[i] as { fn: unknown; deps: unknown[] } | undefined;
      if (!old || changed(old.deps, deps)) h.slots[i] = { fn, deps };
      return (h.slots[i] as { fn: unknown }).fn;
    },
    useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
      const i = h.cursor++;
      const old = h.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (changed(old?.deps, deps)) h.effects.push(() => {
        old?.cleanup?.();
        h.slots[i] = { deps, cleanup: fn() };
      });
    },
  };
});
vi.mock("mpegts.js", () => ({ default: {
  isSupported: () => true,
  Events: { ERROR: "error", LOADING_COMPLETE: "complete" },
  createPlayer: vi.fn(() => {
    const player = { load: vi.fn(), play: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), attachMediaElement: vi.fn(), on: vi.fn() };
    h.players.push(player);
    return player;
  }),
} }));
vi.mock("../../api/client", () => ({ previewWsUrl: vi.fn() }));
vi.mock("../../utils/error/errorDiagnostics", () => ({ reportError: vi.fn() }));
vi.mock("../../utils/player/livePreviewConfig", () => ({ livePreviewConfig: vi.fn() }));
vi.mock("../../utils/player/previewMediaClock", () => ({ resetPreviewMediaClock: vi.fn(), setLiveMediaOrigin: vi.fn(), readPreviewElapsed: () => 1.25 }));
vi.mock("../../utils/player/prepareSeekPlayback", () => ({ prepareSeekPlayback: (_video: unknown, _offset: unknown, ready: () => void) => {
  h.ready = ready;
  return vi.fn();
} }));
vi.mock("../../utils/player/seekPlaybackHealth", () => ({ watchSeekPlayback: () => ({ stop: vi.fn(), presented: vi.fn() }) }));
vi.mock("../../utils/player/videoFrameTransition", () => ({ holdVideoFrame: vi.fn(), releaseVideoFrame: vi.fn(), waitForVideoFrame: (_video: unknown, frame: () => void) => {
  h.frame = frame;
  return vi.fn();
} }));
import { useVideoPlayback } from "./useVideoPlayback";
import { livePreviewConfig } from "../../utils/player/livePreviewConfig";

function render(props: VideoPlayerProps, video: HTMLVideoElement) {
  h.cursor = 0;
  // React is mocked above; this helper drives the simulated hook lifecycle.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  const result = useVideoPlayback(props);
  result.attachVideoRef(video);
  h.effects.splice(0).forEach((effect) => effect());
  return result;
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.players = [];
  h.ready = h.frame = null;
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  for (const slot of h.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live startup watchdog", () => {
  const liveVideo = () => Object.assign(new EventTarget(), {
    pause: vi.fn(), currentTime: 0, paused: false, muted: true, volume: 1,
  }) as unknown as HTMLVideoElement;

  it('reports real loading stages and completes only after the first frame is presented', () => {
    const video = liveVideo();
    const frameReady = vi.fn();
    const props = { roomId: 'progress-room', platform: 'youtube' as const, onFrameReadyChange: frameReady };
    render(props, video);
    expect(frameReady).toHaveBeenLastCalledWith(false);
    const progress = vi.mocked(livePreviewConfig).mock.calls.at(-1)![3]!;
    progress('stream_url_ready');
    expect(render(props, video).loadProgress.percent).toBe(45);
    progress('receiving_media'); progress('youtube_manifests_ready');
    expect(render(props, video).loadProgress.percent).toBe(90);
    video.dispatchEvent(new Event('loadeddata'));
    let result = render(props, video);
    expect(result.state).toBe('loading');
    expect(result.loadProgress.percent).toBe(95);
    expect(result.hasEverPlayedRef.current).toBe(false);
    expect(frameReady).toHaveBeenLastCalledWith(false);
    h.frame?.();
    result = render(props, video);
    expect(result.state).toBe('playing');
    expect(result.loadProgress.percent).toBe(100);
    expect(result.hasEverPlayedRef.current).toBe(true);
    expect(frameReady).toHaveBeenLastCalledWith(true);
  });

  it('resets progress for a retry and ignores callbacks from the retired player', async () => {
    vi.useFakeTimers();
    const video = liveVideo();
    render({ roomId: 'retry-progress', platform: 'youtube' }, video);
    const progress = vi.mocked(livePreviewConfig).mock.calls.at(-1)![3]!;
    progress('receiving_media');
    const error = h.players[0].on.mock.calls.find(args => args[0] === 'error')![1] as () => void;
    error();
    progress('decoded');
    let result = render({ roomId: 'retry-progress', platform: 'youtube' }, video);
    expect(result.loadProgress.percent).toBe(5);
    expect(result.loadProgress.label).toContain('重试');
    await vi.advanceTimersByTimeAsync(1000);
    progress('presented');
    result = render({ roomId: 'retry-progress', platform: 'youtube' }, video);
    expect(result.loadProgress.percent).toBe(5);
    expect(result.state).toBe('loading');
  });

  it.each([false, true])("keeps YouTube startup connected beyond 12 seconds (thumbnail=%s), then bounds it", async (thumbnail) => {
    vi.useFakeTimers();
    render({ roomId: "youtube-room", platform: "youtube", thumbnail }, liveVideo());
    expect(livePreviewConfig).toHaveBeenLastCalledWith(thumbnail, thumbnail ? undefined : expect.any(Function), 'youtube', thumbnail ? undefined : expect.any(Function));
    const first = h.players[0];
    await vi.advanceTimersByTimeAsync(28_000);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(h.players).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(62_000);
    expect(first.destroy).toHaveBeenCalledOnce();
  });

  it("still reconnects a stalled YouTube stream 12 seconds after playback", async () => {
    vi.useFakeTimers();
    const video = liveVideo();
    render({ roomId: "youtube-room", platform: "youtube" }, video);
    await vi.advanceTimersByTimeAsync(28_000);
    video.dispatchEvent(new Event("playing"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.players[0].destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.players[0].destroy).toHaveBeenCalledOnce();
  });

  it("preserves the 12 second startup watchdog for existing platforms", async () => {
    vi.useFakeTimers();
    render({ roomId: "douyin-room", platform: "douyin" }, liveVideo());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(h.players[0].destroy).toHaveBeenCalledOnce();
  });
});
describe("seek player lifecycle", () => {
  it("does not restart during parent clock refreshes and reports the first frame to the latest callback", () => {
    const video = Object.assign(new EventTarget(), { pause: vi.fn(), currentTime: 0, muted: true, volume: 1 }) as unknown as HTMLVideoElement;
    const seek = { recordingId: "r", url: "/seek", generation: 1, second: 10, startSecond: 9 };
    const oldFrame = vi.fn();
    render({ roomId: "room", seek, onSeekTail: vi.fn(), onSeekFirstFrame: oldFrame, onSeekError: vi.fn() }, video);
    const firstPlayer = h.players[0];
    const frameReady = vi.fn();
    const latestFrame = vi.fn();
    const latestTail = vi.fn();
    for (let i = 0; i < 5; i++) render({ roomId: "room", seek, onFrameReadyChange: frameReady, onSeekTail: latestTail, onSeekFirstFrame: latestFrame, onSeekError: vi.fn() }, video);
    expect(h.players).toHaveLength(1);
    expect(firstPlayer.destroy).not.toHaveBeenCalled();
    h.ready?.();
    video.dispatchEvent(new Event("playing"));
    expect(frameReady).not.toHaveBeenCalledWith(true);
    h.frame?.();
    expect(frameReady).toHaveBeenLastCalledWith(true);
    expect(latestFrame).toHaveBeenCalledWith(1, 1.25);
    expect(oldFrame).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("ended"));
    expect(latestTail).toHaveBeenCalledOnce();
    render({ roomId: "room", onFrameReadyChange: frameReady, seek: { ...seek, generation: 2, url: "/seek2" } }, video);
    expect(firstPlayer.destroy).toHaveBeenCalledOnce();
    expect(frameReady).toHaveBeenLastCalledWith(false);
    expect(h.players).toHaveLength(2);
  });
});


describe("preview audio preference", () => {
  const key = "live-recorder.preview-audio";
  const videoElement = () => Object.assign(new EventTarget(), {
    pause: vi.fn(), currentTime: 0, paused: false, muted: true, volume: 1,
  }) as unknown as HTMLVideoElement;
  const unmount = () => {
    for (const slot of h.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
    h.slots = [];
  };
  let storage: Map<string, string>;
  let setItem: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    storage = new Map();
    setItem = vi.fn((name: string, value: string) => storage.set(name, value));
    vi.stubGlobal("window", { localStorage: {
      getItem: (name: string) => storage.get(name) ?? null, setItem,
    } });
  });

  it.each([false, true])("restores volume and muted=%s after closing and reopening", (muted) => {
    const first = videoElement();
    render({ roomId: "first", rememberAudio: true }, first);
    first.dispatchEvent(new Event("playing"));
    first.volume = 0.37;
    first.muted = muted;
    first.dispatchEvent(new Event("volumechange"));
    unmount();
    const reopened = videoElement();
    render({ roomId: "second", rememberAudio: true }, reopened);
    expect(reopened.muted).toBe(true); // Temporary autoplay mute.
    reopened.dispatchEvent(new Event("volumechange"));
    expect(JSON.parse(storage.get(key)!)).toEqual({ volume: 0.37, muted });
    reopened.dispatchEvent(new Event("playing"));
    expect(reopened.volume).toBe(0.37);
    expect(reopened.muted).toBe(muted);
  });

  it("ignores thumbnail and wall audio changes", () => {
    storage.set(key, JSON.stringify({ volume: 0.4, muted: false }));
    for (const props of [{ thumbnail: true, rememberAudio: true }, {}]) {
      const video = videoElement();
      render({ roomId: "room", ...props }, video);
      video.dispatchEvent(new Event("playing"));
      expect(video.muted).toBe(true);
      video.dispatchEvent(new Event("volumechange"));
      unmount();
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each(["invalid json", '{"volume":2,"muted":false}', '{"volume":0.4}'])
    ("uses the initial default for invalid storage: %s", (saved) => {
      storage.set(key, saved);
      const video = videoElement();
      render({ roomId: "room", rememberAudio: true }, video);
      video.dispatchEvent(new Event("playing"));
      expect(video.volume).toBe(1);
      expect(video.muted).toBe(true);
    });

  it("keeps playback working when storage is unavailable", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("unavailable"); } });
    const video = videoElement();
    expect(() => render({ roomId: "room", rememberAudio: true }, video)).not.toThrow();
    video.dispatchEvent(new Event("playing"));
    video.volume = 0;
    expect(() => video.dispatchEvent(new Event("volumechange"))).not.toThrow();
  });
});
