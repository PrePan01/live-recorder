import type { RecordingMarker } from "../types/recording";

export function markerNeighbors(
  markers: RecordingMarker[],
  second: number | undefined,
  live: boolean,
) {
  let current = -1;
  let previous = -1;
  let next = -1;
  for (let i = 0; i < markers.length; i += 1) {
    const position = markers[i].positionSeconds;
    if (live) {
      previous = i;
      continue;
    }
    if (second == null) continue;
    if (position <= second + 0.5) current = i;
    if (position < second - 0.5) previous = i;
    if (next === -1 && position > second + 0.5) next = i;
  }
  return { current, previous, next };
}

export function markerClipRange(
  position: number,
  duration: number,
  before = 5,
  after = 15,
): [number, number] | null {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0)
    return null;
  const start = Math.max(0, Math.floor(position - before));
  const end = Math.min(Math.floor(duration), Math.ceil(position + after));
  return end > start ? [start, end] : null;
}

/** 两种播放器共用默认片段名，过滤文件系统保留字符。 */
export function markerClipName(title: string, label = "片段"): string {
  return Array.from(`${title}_${label}`, (char) =>
    char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char,
  )
    .join("")
    .slice(0, 120)
    .trim();
}
