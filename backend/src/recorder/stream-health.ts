import { AppError } from "../types/error.js";

export const STREAM_IDLE_MS = 15_000;
export const MEDIA_IDLE_MS = 30_000;

/** Measures only time spent waiting on the upstream. Local writer admission,
 * preview consumers and generator suspension never count as network silence. */
export class StreamHealth {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waitingSince: number | null = null;
  private mediaWaitMs = 0;
  private started = false;
  private media = false;
  private failure: AppError | null = null;
  constructor(
    private readonly idleMs: number,
    private readonly mediaMs: number,
    private readonly interrupt: () => void,
  ) {}
  received(progress: boolean, observeMedia = false): void {
    this.started = true;
    this.media = observeMedia;
    if (progress || !observeMedia) this.mediaWaitMs = 0;
  }
  begin(): void {
    if (!this.started || this.timer || this.failure) return;
    this.waitingSince = performance.now();
    const remaining = this.media
      ? this.mediaMs - this.mediaWaitMs
      : this.idleMs;
    const timeout = Math.max(1, Math.min(this.idleMs, remaining));
    this.timer = setTimeout(() => {
      // Give queued I/O one turn to resolve a read after an event-loop pause.
      // pause() cancels this confirmation if data has already arrived.
      this.timer = setTimeout(
        () => {
          this.timer = null;
          const mediaFrozen = this.media && remaining <= this.idleMs;
          this.failure = new AppError(
            "NETWORK_UNAVAILABLE",
            mediaFrozen
              ? "直播媒体进度持续停滞，正在恢复"
              : "直播源持续无数据，正在恢复",
            {
              retryable: true,
              details: {
                reasonCategory: "stream_timeout",
                trigger: mediaFrozen ? "media_stall" : "upstream_idle",
                idleTimeoutMs: this.idleMs,
                mediaTimeoutMs: this.mediaMs,
                mediaWaitMs:
                  this.mediaWaitMs +
                  performance.now() -
                  (this.waitingSince ?? performance.now()),
              },
            },
          );
          this.interrupt();
        },
        Math.min(250, this.idleMs / 10),
      );
      this.timer.unref();
    }, timeout);
    this.timer.unref();
  }
  pause(): void {
    if (this.waitingSince !== null)
      this.mediaWaitMs +=
        performance.now() - (this.waitingSince ?? performance.now());
    this.waitingSince = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  check(): void {
    if (this.failure) throw this.failure;
  }
}
