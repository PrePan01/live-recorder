export function timelinePercent(second: number, timelineEnd: number): number {
  return timelineEnd > 0
    ? Math.max(0, Math.min(100, (second / timelineEnd) * 100))
    : 0;
}

export function timelineSecondAt(
  clientX: number,
  contentLeft: number,
  contentWidth: number,
  timelineEnd: number,
  recordingEnd: number,
): number {
  return contentWidth > 0
    ? Math.max(
        0,
        Math.min(
          recordingEnd,
          Math.round(((clientX - contentLeft) / contentWidth) * timelineEnd),
        ),
      )
    : 0;
}

export function rangeAtSecond(
  range: [number, number],
  handle: "start" | "end",
  second: number,
  recordingEnd: number,
): [number, number] {
  return handle === "start"
    ? [Math.max(0, Math.min(second, range[1] - 1)), range[1]]
    : [range[0], Math.min(recordingEnd, Math.max(second, range[0] + 1))];
}

/** 选区边界、直播尾部和回看进度分别拥有独立的时间来源。 */
export function previewPosition(
  mode: "live" | "history" | undefined,
  recordingEnd: number,
  playbackSecond: number | undefined,
): number | undefined {
  if (!mode) return undefined;
  const second = mode === "live" ? recordingEnd : playbackSecond;
  return second == null
    ? undefined
    : Math.max(0, Math.min(recordingEnd, second));
}

/** 吸附偏移合理上限（一个 GOP 量级）；超出即索引错乱信号，不能拿错误吸附秒冒充真值。 */
export const SEEK_SNAP_MAX_SKEW = 10;

export function isPlausibleSeekOffset(
  targetSecond: number,
  startSecond: number,
): boolean {
  return Math.abs(targetSecond - startSecond) <= SEEK_SNAP_MAX_SKEW;
}
