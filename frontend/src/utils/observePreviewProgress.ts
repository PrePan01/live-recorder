import { readPreviewElapsed } from "./previewMediaClock";
/** 只读媒体进度，不调用 play/pause，也不写入 currentTime。 */
export function observePreviewProgress(
  video: HTMLVideoElement,
  onProgress: (elapsed: number) => void,
  isCurrentSource: () => boolean = () => true,
): () => void {
  let metadataReady = video.readyState >= 2;
  const report = () => {
    if (
      !isCurrentSource() ||
      !metadataReady ||
      video.readyState < 2 ||
      video.buffered.length === 0
    )
      return;
    const elapsed = readPreviewElapsed(video);
    if (elapsed != null) onProgress(elapsed);
  };
  const metadata = () => {
    metadataReady = true;
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
