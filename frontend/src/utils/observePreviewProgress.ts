/** 只读媒体进度，不调用 play/pause，也不写入 currentTime。 */
export function observePreviewProgress(
  video: HTMLVideoElement,
  onProgress: (elapsed: number) => void,
  isCurrentSource: () => boolean = () => true,
): () => void {
  let mediaStart: number | null = null;
  let metadataReady = video.readyState >= 2;
  const report = () => {
    if (
      !isCurrentSource() ||
      !metadataReady ||
      video.readyState < 2 ||
      video.buffered.length === 0
    )
      return;
    mediaStart ??= video.buffered.start(0);
    onProgress(Math.max(0, video.currentTime - mediaStart));
  };
  const metadata = () => {
    metadataReady = true;
    mediaStart = null;
    report();
  };
  video.addEventListener("loadedmetadata", metadata);
  video.addEventListener("loadeddata", report);
  video.addEventListener("playing", report);
  video.addEventListener("timeupdate", report);
  video.addEventListener("seeked", report);
  report();
  return () => {
    video.removeEventListener("loadedmetadata", metadata);
    video.removeEventListener("loadeddata", report);
    video.removeEventListener("playing", report);
    video.removeEventListener("timeupdate", report);
    video.removeEventListener("seeked", report);
  };
}
