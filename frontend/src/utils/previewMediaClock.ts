// mpegts rebases each connection to its first media DTS. Keep that origin for
// the lifetime of the source; buffered.start() moves as old buffers are removed.
const clocks = new WeakMap<HTMLVideoElement, { liveOrigin?: number; seekOrigin?: number }>();

export function resetPreviewMediaClock(video: HTMLVideoElement) {
  clocks.set(video, {});
}

export function setLiveMediaOrigin(video: HTMLVideoElement, milliseconds: number) {
  const clock = clocks.get(video) ?? {};
  clock.liveOrigin = milliseconds / 1000;
  clocks.set(video, clock);
}

export function previewMediaSource(video: HTMLVideoElement) { return clocks.get(video); }

export function readLiveMediaSecond(video: HTMLVideoElement): number | undefined {
  const origin = clocks.get(video)?.liveOrigin;
  return origin == null ? undefined : origin + video.currentTime;
}

export function readPreviewElapsed(video: HTMLVideoElement): number | undefined {
  if (video.readyState < 2 || !video.buffered.length) return undefined;
  const clock = clocks.get(video) ?? {};
  clock.seekOrigin ??= video.buffered.start(0);
  clocks.set(video, clock);
  return Math.max(0, video.currentTime - clock.seekOrigin);
}

/** Inspect only bootstrap headers, skipping payloads without copying them. */
export class FlvMediaOriginReader {
  private header = new Uint8Array(13);
  private filled = 0;
  private skip = 0;
  private phase: "bootstrap" | "tag" | "prefix" = "bootstrap";
  private audio = false;
  private video = false;
  private timestamps = new Map<number, number>();
  private done = false;
  private tagCount = 0;
  private tag = { type: 0, size: 0, timestamp: 0 };
  private onOrigin: (milliseconds: number) => void;
  constructor(onOrigin: (milliseconds: number) => void) { this.onOrigin = onOrigin; }

  push(buffer: ArrayBuffer) {
    if (this.done) return;
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < bytes.length && !this.done) {
      if (this.skip) {
        const count = Math.min(this.skip, bytes.length - offset);
        this.skip -= count;
        offset += count;
        continue;
      }
      const count = Math.min(this.header.length - this.filled, bytes.length - offset);
      this.header.set(bytes.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled !== this.header.length) continue;
      const h = this.header;
      this.filled = 0;
      if (this.phase === "bootstrap") {
        if (h[0] !== 0x46 || h[1] !== 0x4c || h[2] !== 0x56) { this.done = true; return; }
        this.audio = Boolean(h[4]! & 4);
        this.video = Boolean(h[4]! & 1);
        const dataOffset = new DataView(h.buffer).getUint32(5);
        if (dataOffset < 9 || dataOffset > 1024) { this.done = true; return; }
        this.skip = dataOffset - 9;
        this.phase = "tag";
        this.header = new Uint8Array(11);
      } else if (this.phase === "tag") {
        if (++this.tagCount > 1024) { this.done = true; return; }
        this.tag = {
          type: h[0]!, size: h[1]! * 65536 + h[2]! * 256 + h[3]!,
          timestamp: h[4]! * 65536 + h[5]! * 256 + h[6]! + h[7]! * 16777216,
        };
        if ((this.tag.type === 8 || this.tag.type === 9) && this.tag.size >= 2) {
          this.phase = "prefix";
          this.header = new Uint8Array(2);
        } else { this.skip = this.tag.size + 4; }
      } else {
        const { type, size, timestamp } = this.tag;
        const sequence = type === 8
          ? (h[0]! >> 4) === 10 && h[1] === 0
          : Boolean((h[0]! & 0x80) ? (h[0]! & 15) === 0 : [7, 12].includes(h[0]! & 15) && h[1] === 0);
        if (!sequence && !this.timestamps.has(type)) {
          this.timestamps.set(type, timestamp);
          this.onOrigin(Math.min(...this.timestamps.values()));
          this.done = (!this.audio || this.timestamps.has(8)) && (!this.video || this.timestamps.has(9));
        }
        this.skip = size - 2 + 4;
        this.phase = "tag";
        this.header = new Uint8Array(11);
      }
    }
  }
}
