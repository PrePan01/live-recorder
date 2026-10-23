import { readPreviewElapsed, resetPreviewMediaClock } from "./previewMediaClock";

/** One committed source clock for compatible playback, markers and danmaku.
 * A seek invalidates old frames synchronously, before React mounts the new source.
 */
export class FilePlaybackClock {
  private generation = 0;
  private source: HTMLVideoElement | null = null;
  private ready = false;
  private baseSecond: number;
  constructor(baseSecond = 0) { this.baseSecond = baseSecond; }

  begin(second: number): number {
    this.baseSecond = second;
    this.ready = false;
    this.source = null;
    return ++this.generation;
  }
  attach(video: HTMLVideoElement, generation: number): boolean {
    if (generation !== this.generation) return false;
    this.source = video;
    this.ready = false;
    resetPreviewMediaClock(video);
    return true;
  }
  isCurrent(video: HTMLVideoElement, generation: number): boolean {
    return generation === this.generation && video === this.source;
  }
  present(video: HTMLVideoElement, generation: number): boolean {
    if (!this.isCurrent(video, generation) || readPreviewElapsed(video) == null) return false;
    this.ready = true;
    return true;
  }
  read(video: HTMLVideoElement | null): number | undefined {
    if (!this.ready || !video || video !== this.source) return undefined;
    const elapsed = readPreviewElapsed(video);
    return elapsed == null ? undefined : this.baseSecond + elapsed;
  }
}
