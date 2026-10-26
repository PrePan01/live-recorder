/** 首帧有截止时间；播放后尊重主动暂停，只有媒体时间停滞才判失败。 */
export function watchSeekPlayback(
  video: HTMLVideoElement,
  onFailure: (reason: "first-frame" | "stall") => void,
  isCurrent: () => boolean,
  firstFrameTimeoutMs = 15_000,
  stallTimeoutMs = 12_000,
) {
  let hasFrame = false;
  let stopped = false;
  let lastTime = video.currentTime;
  let lastProgress = Date.now();
  const started = lastProgress;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || !isCurrent()) return;
    const now = Date.now();
    if (!hasFrame) {
      if (now - started < firstFrameTimeoutMs) return;
      stop();
      onFailure("first-frame");
      return;
    }
    if (
      video.paused ||
      video.ended ||
      Math.abs(video.currentTime - lastTime) > 0.01
    ) {
      lastTime = video.currentTime;
      lastProgress = now;
    } else if (now - lastProgress >= stallTimeoutMs) {
      stop();
      onFailure("stall");
    }
  }, 1000);
  return {
    stop,
    presented: () => {
      hasFrame = true;
      lastTime = video.currentTime;
      lastProgress = Date.now();
    },
  };
}
