/** 等新源缓冲覆盖目标后，完成媒体定位，再允许播放。offset 是目标距解码关键帧的秒数。
 *  WebKit 上媒体内核会把「当前时间<1s」的 seek 拉回缓冲起点，定位前先把播放头推过守卫区；
 *  等待超时则从缓冲起点放行（误差不超一个 GOP），不再无限等。 */
export function prepareSeekPlayback(
  video: HTMLVideoElement,
  offset: number,
  onReady: () => void,
  isCurrent: () => boolean = () => true,
  onFallback?: () => void,
  readyTimeoutMs: number = 8000,
): () => void {
  let metadataReady = false;
  let mediaStart: number | null = null;
  let seeking = false;
  let ready = false;
  let hopping = false;
  let seekAttempts = 0;
  video.pause();
  const finish = (fallback: boolean) => {
    if (ready || !isCurrent()) return;
    ready = true;
    if (fallback) onFallback?.();
    onReady();
  };
  const check = () => {
    if (ready || !isCurrent() || !metadataReady || video.buffered.length === 0)
      return;
    mediaStart ??= video.buffered.start(0);
    const target = mediaStart + Math.max(0, offset);
    const covered = Array.from(
      { length: video.buffered.length },
      (_, i) => i,
    ).some(
      (i) => video.buffered.start(i) <= target && video.buffered.end(i) > target,
    );
    if (!covered) return;
    if (Math.abs(video.currentTime - target) <= 0.05 && !video.seeking) {
      finish(false);
    } else if (hopping) {
      if (video.currentTime < 1) return;
      // 已推过守卫区：暂停复速，再精确定位（此时 seek 不会被内核拉回）。
      hopping = false;
      video.pause();
      video.playbackRate = 1;
      seeking = true;
      video.currentTime = target;
    } else if (!seeking) {
      // 先按常规直接定位；若落点被内核劫持（seeked 后回不到目标），再推过守卫区重试。
      seeking = true;
      seekAttempts += 1;
      video.currentTime = target;
    }
  };
  const metadata = () => {
    metadataReady = true;
    check();
  };
  const seeked = () => {
    seeking = false;
    if (
      !ready &&
      !hopping &&
      metadataReady &&
      video.buffered.length > 0 &&
      seekAttempts < 3
    ) {
      mediaStart ??= video.buffered.start(0);
      const target = mediaStart + Math.max(0, offset);
      // 落点没到目标=seek 被内核劫持（WebKit 把 <1s 的 seek 拉回缓冲起点）：
      // 倍速推过守卫区后再定位，而不是在劫持区里反复写。
      if (
        Math.abs(video.currentTime - target) > 0.05 &&
        video.currentTime < 1
      ) {
        hopping = true;
        video.playbackRate = 8;
        void Promise.resolve(video.play()).catch(() => undefined);
        return;
      }
    }
    check();
  };
  video.addEventListener("loadedmetadata", metadata);
  for (const event of ["progress", "loadeddata", "canplay", "timeupdate"])
    video.addEventListener(event, check);
  video.addEventListener("seeked", seeked);
  const watchdog = setTimeout(() => {
    if (!ready && isCurrent()) finish(true);
  }, readyTimeoutMs);
  return () => {
    ready = true;
    clearTimeout(watchdog);
    if (hopping) {
      video.playbackRate = 1;
      video.pause();
    }
    video.removeEventListener("loadedmetadata", metadata);
    for (const event of ["progress", "loadeddata", "canplay", "timeupdate"])
      video.removeEventListener(event, check);
    video.removeEventListener("seeked", seeked);
  };
}
