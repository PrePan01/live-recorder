const BUFFER_GRACE_MS = 180;

export function danmakuPlaybackRate(video: Pick<HTMLMediaElement,
  'paused' | 'ended' | 'seeking' | 'readyState' | 'playbackRate'> | null): number {
  // HAVE_CURRENT_DATA is enough to preserve motion. Brief loss of future data is not a pause.
  return video && !video.paused && !video.ended && !video.seeking && video.readyState >= 2
    ? video.playbackRate : 0;
}

/** Explicit media events control native animations; transient buffer fluctuations get a grace period. */
export class DanmakuPlayback {
  private video: HTMLVideoElement | null = null;
  private buffering = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private getVideo: () => HTMLVideoElement | null;
  private notify: () => void;
  private readonly events = ['play', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'loadeddata', 'emptied', 'error'] as const;

  constructor(getVideo: () => HTMLVideoElement | null, notify: () => void) {
    this.getVideo = getVideo; this.notify = notify;
  }
  sample() {
    const video = this.getVideo();
    if (video !== this.video) {
      this.detach(); this.video = video;
      for (const event of this.events) video?.addEventListener(event, this.changed);
      video?.addEventListener('waiting', this.waiting);
      video?.addEventListener('playing', this.playing);
    }
    return this.buffering ? 0 : danmakuPlaybackRate(video);
  }
  destroy() { this.detach(); }
  private changed = () => { this.notify(); };
  private waiting = () => {
    if (this.timer != null || this.buffering) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.buffering = true; this.notify();
    }, BUFFER_GRACE_MS);
  };
  private playing = () => {
    clearTimeout(this.timer); this.timer = undefined; this.buffering = false; this.notify();
  };
  private detach() {
    clearTimeout(this.timer); this.timer = undefined; this.buffering = false;
    for (const event of this.events) this.video?.removeEventListener(event, this.changed);
    this.video?.removeEventListener('waiting', this.waiting);
    this.video?.removeEventListener('playing', this.playing);
    this.video = null;
  }
}
