export function playbackClock(value: number, showHours = true): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = showHours
    ? Math.floor(seconds / 60) % 60
    : Math.floor(seconds / 60);
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return showHours && hours > 0
    ? `${String(hours).padStart(2, "0")}:${clock}`
    : clock;
}

/** 毫秒转HH:MM:SS */
export function hmsClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
