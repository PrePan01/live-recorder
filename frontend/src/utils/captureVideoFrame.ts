export const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export function canCaptureVideoFrame(
  video: HTMLVideoElement | null,
): video is HTMLVideoElement {
  return Boolean(
    video &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    !video.seeking &&
    !video.error,
  );
}

/** drawImage runs before the first await: encoding cannot advance the captured frame. */
export function captureVideoFrame(
  video: HTMLVideoElement | null,
): Promise<Blob> {
  if (!canCaptureVideoFrame(video))
    throw new Error("当前没有可截取的画面，请等待画面加载完成");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const release = () => {
    canvas.width = 0;
    canvas.height = 0;
  };
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法截取画面，请重试");
    context.drawImage(video, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          release();
          if (!blob || blob.type !== "image/png")
            reject(new Error("截图编码失败，请重试"));
          else if (blob.size > MAX_SCREENSHOT_BYTES)
            reject(new Error("截图过大，不能超过 32 MiB"));
          else resolve(blob);
        }, "image/png");
      } catch {
        release();
        reject(new Error("截图编码失败，请重试"));
      }
    });
  } catch (error) {
    release();
    throw new Error(
      error instanceof Error
        ? `截图失败：${error.message}`
        : "截图失败，请重试",
    );
  }
}
