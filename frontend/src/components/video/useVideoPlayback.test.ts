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
      return [h.slots[i], (next: unknown) => { h.slots[i] = next; }];
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
  Events: { ERROR: "error", LOADING_COMPLETE: "complete" },
  createPlayer: vi.fn(() => {
    const player = { load: vi.fn(), play: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), attachMediaElement: vi.fn(), on: vi.fn() };
    h.players.push(player);
    return player;
  }),
} }));
vi.mock("../../api/client", () => ({ previewWsUrl: vi.fn() }));
vi.mock("../../utils/errorDiagnostics", () => ({ reportError: vi.fn() }));
vi.mock("../../utils/livePreviewConfig", () => ({ livePreviewConfig: vi.fn() }));
vi.mock("../../utils/previewMediaClock", () => ({ resetPreviewMediaClock: vi.fn(), setLiveMediaOrigin: vi.fn(), readPreviewElapsed: () => 1.25 }));
vi.mock("../../utils/prepareSeekPlayback", () => ({ prepareSeekPlayback: (_video: unknown, _offset: unknown, ready: () => void) => {
  h.ready = ready;
  return vi.fn();
} }));
vi.mock("../../utils/seekPlaybackHealth", () => ({ watchSeekPlayback: () => ({ stop: vi.fn(), presented: vi.fn() }) }));
vi.mock("../../utils/videoFrameTransition", () => ({ holdVideoFrame: vi.fn(), releaseVideoFrame: vi.fn(), waitForVideoFrame: (_video: unknown, frame: () => void) => {
  h.frame = frame;
  return vi.fn();
} }));
import { useVideoPlayback } from "./useVideoPlayback";

function render(props: VideoPlayerProps, video: HTMLVideoElement) {
  h.cursor = 0;
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
});
describe("seek player lifecycle", () => {
  it("does not restart during parent clock refreshes and reports the first frame to the latest callback", () => {
    const video = Object.assign(new EventTarget(), { pause: vi.fn(), currentTime: 0, muted: true, volume: 1 }) as unknown as HTMLVideoElement;
    const seek = { recordingId: "r", url: "/seek", generation: 1, second: 10, startSecond: 9 };
    const oldFrame = vi.fn();
    render({ roomId: "room", seek, onSeekTail: vi.fn(), onSeekFirstFrame: oldFrame, onSeekError: vi.fn() }, video);
    const firstPlayer = h.players[0];
    const latestFrame = vi.fn();
    const latestTail = vi.fn();
    for (let i = 0; i < 5; i++) render({ roomId: "room", seek, onSeekTail: latestTail, onSeekFirstFrame: latestFrame, onSeekError: vi.fn() }, video);
    expect(h.players).toHaveLength(1);
    expect(firstPlayer.destroy).not.toHaveBeenCalled();
    h.ready?.();
    video.dispatchEvent(new Event("playing"));
    h.frame?.();
    expect(latestFrame).toHaveBeenCalledWith(1, 1.25);
    expect(oldFrame).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("ended"));
    expect(latestTail).toHaveBeenCalledOnce();
    render({ roomId: "room", seek: { ...seek, generation: 2, url: "/seek2" } }, video);
    expect(firstPlayer.destroy).toHaveBeenCalledOnce();
    expect(h.players).toHaveLength(2);
  });
});
