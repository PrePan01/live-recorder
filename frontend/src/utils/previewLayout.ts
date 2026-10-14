const FALLBACK_RATIO = 16 / 9;

export interface PreviewVideoBox {
  width: number;
  height: number;
}

/** 比例无效（0/负数/NaN/无穷）时退回 16:9，避免算出 0 或 Infinity 的尺寸。 */
function sanitizeRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_RATIO;
}

function boxOf(ratio: number, height: number): PreviewVideoBox {
  return { width: height * ratio, height };
}

/**
 * 预览画面尺寸：按流的真实宽高比适配（ratio 为 宽 / 高）。
 *
 * 横屏按宽度适配（与既有行为一致）；竖屏按可用高度适配并收窄宽度，
 * 否则 9:16 的流按弹窗宽度算出来的高度会超过一屏。
 */
export function fitPreviewBox(
  ratio: number,
  preferredWidth: number,
  maxHeight: number,
): PreviewVideoBox {
  const safeRatio = sanitizeRatio(ratio);
  const heightForWidth = preferredWidth / safeRatio;
  const height = Math.min(heightForWidth, maxHeight);
  return boxOf(safeRatio, height);
}

/** 按指定高度适配（竖屏拖拽缩放用）：高度始终不超过可用高度。 */
export function fitPreviewBoxByHeight(
  ratio: number,
  preferredHeight: number,
  maxHeight: number,
): PreviewVideoBox {
  const safeRatio = sanitizeRatio(ratio);
  return boxOf(safeRatio, Math.max(0, Math.min(preferredHeight, maxHeight)));
}

/** 视频与轨道共同占位：横屏轨道跟随视频宽度，竖屏轨道占可用宽度的 80%。 */
export function fitPreviewContent({
  ratio,
  availableWidth,
  availableHeight,
  trackHeight,
  occupiedTrackHeight,
  preferredVideoHeight,
}: {
  ratio: number;
  availableWidth: number;
  availableHeight: number;
  trackHeight: number;
  occupiedTrackHeight: number;
  preferredVideoHeight?: number;
}) {
  const videoHeightCap = Math.max(0, availableHeight - trackHeight);
  const settledBox = fitPreviewBox(
    ratio,
    availableWidth,
    Math.max(
      0,
      Math.min(preferredVideoHeight ?? videoHeightCap, videoHeightCap),
    ),
  );
  const contentHeight = settledBox.height + trackHeight;
  const videoBox = fitPreviewBox(
    ratio,
    availableWidth,
    Math.max(0, contentHeight - occupiedTrackHeight),
  );
  return {
    videoBox,
    contentHeight,
    trackWidth:
      sanitizeRatio(ratio) < 1 ? availableWidth * 0.8 : videoBox.width,
  };
}
