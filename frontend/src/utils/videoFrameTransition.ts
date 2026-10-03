/** 每次切流只复制一次原尺寸画面，避免编码图片或持续占用第二个解码器。 */
export function holdVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): void {
  if (canvas.style.display === "block") return;
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  try {
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0);
    canvas.style.display = "block";
  } catch {
    // 无法复制时仍允许正常切流。
  }
}

export function releaseVideoFrame(canvas: HTMLCanvasElement): void {
  canvas.style.display = "none";
  canvas.width = 0;
  canvas.height = 0;
}

/** playing 只表示开始播放，须等帧交给合成器后才能揭开切流遮罩。 */
export function waitForVideoFrame(
  video: HTMLVideoElement,
  onFrame: () => void,
  isCurrent: () => boolean,
): () => void {
  let cancelled = false;
  let frame: number;
  const presented = () => {
    if (!cancelled && isCurrent()) onFrame();
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    frame = video.requestVideoFrameCallback(presented);
    return () => {
      cancelled = true;
      video.cancelVideoFrameCallback(frame);
    };
  }
  // 旧内核没有视频帧回调：等可播放画面经过一个完整绘制周期。
  let painted = false;
  const check = () => {
    if (cancelled || !isCurrent()) return;
    if (video.readyState >= 2 && !video.seeking) {
      if (painted) {
        presented();
        return;
      }
      painted = true;
    } else painted = false;
    frame = requestAnimationFrame(check);
  };
  frame = requestAnimationFrame(check);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
