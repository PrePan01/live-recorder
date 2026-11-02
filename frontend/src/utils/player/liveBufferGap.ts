/** Only bridge a small, proven hole into buffered media. Never chase the live
 * edge or nudge within a contiguous range: that can hide a decoder failure. */
export function liveBufferGapTarget(video: HTMLVideoElement): number | null {
  if (video.paused || video.seeking || video.ended || !(video.readyState >= 1))
    return null;
  const time = video.currentTime;
  if (!Number.isFinite(time)) return null;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (time >= start && time < end - 0.05) return null;
    if (start > time) {
      if (start - time > 0.5 || end - start < 0.25) return null;
      return start + 0.05;
    }
  }
  return null;
}
