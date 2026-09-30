/** 等新源缓冲覆盖目标后，完成媒体定位，再允许播放。offset 是目标距解码关键帧的秒数。 */
export function prepareSeekPlayback(
  video: HTMLVideoElement,
  offset: number,
  onReady: () => void,
  isCurrent: () => boolean = () => true,
): () => void {
  let metadataReady = false;
  let mediaStart: number | null = null;
  let seeking = false;
  let ready = false;
  video.pause();
  const check = () => {
    if (ready || !isCurrent() || !metadataReady || video.buffered.length === 0) return;
    mediaStart ??= video.buffered.start(0);
    const target = mediaStart + Math.max(0, offset);
    const covered = Array.from({ length: video.buffered.length }, (_, i) => i)
      .some((i) => video.buffered.start(i) <= target && video.buffered.end(i) > target);
    if (!covered) return;
    if (Math.abs(video.currentTime - target) <= 0.05 && !video.seeking) {
      ready = true;
      onReady();
    } else if (!seeking) {
      seeking = true;
      video.currentTime = target;
    }
  };
  const metadata = () => {
    metadataReady = true;
    check();
  };
  const seeked = () => {
    seeking = false;
    check();
  };
  video.addEventListener("loadedmetadata", metadata);
  for (const event of ["progress", "loadeddata", "canplay"]) video.addEventListener(event, check);
  video.addEventListener("seeked", seeked);
  return () => {
    ready = true;
    video.removeEventListener("loadedmetadata", metadata);
    for (const event of ["progress", "loadeddata", "canplay"]) video.removeEventListener(event, check);
    video.removeEventListener("seeked", seeked);
  };
}
