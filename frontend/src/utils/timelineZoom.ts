/** Visual overflow for centered handles; the rail itself keeps the shared video bounds. */
export const TIMELINE_VISUAL_OVERFLOW = 16;

export function zoomTimeline(
  zoom: number,
  delta: number,
  width: number,
  scrollLeft: number,
  pointerX: number,
  timelineEnd: number,
) {
  const maxZoom = Math.max(1, Math.min(1024, timelineEnd / 10));
  const nextZoom = Math.max(
    1,
    Math.min(
      maxZoom,
      zoom * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.008),
    ),
  );
  const anchor = Math.max(0, Math.min(width, pointerX));
  return {
    zoom: nextZoom,
    scrollLeft: Math.max(
      0,
      Math.min(
        width * (nextZoom - 1),
        ((scrollLeft + anchor) * nextZoom) / zoom - anchor,
      ),
    ),
  };
}

/** Choose readable clock intervals and draw only the visible portion of the ruler. */
export function timelineTicks(
  end: number,
  zoom: number,
  left: number,
  count = 6,
) {
  if (end <= 0) return [];
  const span = end / zoom;
  const intervals = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600,
    43200, 86400,
  ];
  const step =
    intervals.find((value) => value >= span / count) ??
    Math.ceil(span / count / 86400) * 86400;
  const start = Math.max(0, Math.floor(left / step) * step);
  const ticks: number[] = [];
  for (
    let second = start;
    second <= Math.min(end, left + span + step);
    second += step
  )
    ticks.push(second);
  if (end <= left + span && ticks.at(-1) !== end) {
    if (ticks.length > 1 && end - ticks[ticks.length - 1] < step * 0.6)
      ticks.pop();
    ticks.push(end);
  }
  return ticks;
}

export function visibleTimelineLabels(
  labels: { second: number; left: number; right: number }[],
  end: number,
  gap = 8,
): Set<number> {
  const endpoint = (second: number) => second === 0 || second === end;
  const priority = [...labels].sort(
    (a, b) =>
      Number(endpoint(b.second)) - Number(endpoint(a.second)) ||
      a.second - b.second,
  );
  const accepted: typeof labels = [];
  for (const label of priority) {
    if (
      accepted.every(
        (other) =>
          label.right + gap <= other.left || other.right + gap <= label.left,
      )
    )
      accepted.push(label);
  }
  return new Set(accepted.map((label) => label.second));
}
