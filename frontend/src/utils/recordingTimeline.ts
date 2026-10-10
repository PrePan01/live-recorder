export type RecordingTrackMode = "recording" | "playback";

/** 文件轨道止于片尾；录制轨道按一分钟扩展，保留未来空间。 */
export function recordingTimelineEnd(
  seconds: number,
  mode: RecordingTrackMode,
): number {
  const end = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return mode === "playback"
    ? end
    : Math.max(60, Math.ceil(Math.max(1, end) / 60) * 60);
}

/** 文件选区独立于播放；文件片尾始终是秒数，只有录制模式返回直播。 */
export function recordingSeekTarget(
  mode: RecordingTrackMode,
  kind: "start" | "end" | "playhead",
  second: number,
  duration: number,
  disabled = false,
): number | "live" | undefined {
  if (
    disabled ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(second)
  )
    return undefined;
  if (mode === "playback" && kind !== "playhead") return undefined;
  const target = Math.max(0, Math.min(duration, second));
  return mode === "recording" && target >= duration ? "live" : target;
}

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
  loading = false,
): number | undefined {
  if (!mode) return undefined;
  const second = mode === "live" && !loading ? recordingEnd : playbackSecond;
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
