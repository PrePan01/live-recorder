import type { RecordingGap } from "../types/recording";

function mediaPosition(gap: RecordingGap): number | undefined {
  try {
    const evidence: unknown = JSON.parse(gap.evidence ?? "null");
    if (!evidence || typeof evidence !== "object" || !("mediaPositionMs" in evidence)) return;
    const value = evidence.mediaPositionMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return;
  }
}

function hms(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

/** 录像会拼接有效内容；旧记录只可根据墙钟减去此前中断估算位置。 */
export function recordingGapPosition(
  gap: RecordingGap,
  gaps: RecordingGap[],
  recordingStartedAt: string,
): string | null {
  const position = mediaPosition(gap);
  if (position !== undefined) return hms(position);
  const start = Date.parse(recordingStartedAt);
  const gapStart = Date.parse(gap.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(gapStart)) return null;
  const previousMissingMs = gaps.reduce((sum, previous) => {
    const previousEnd = Date.parse(previous.endedAt);
    return previous.id !== gap.id && Number.isFinite(previousEnd) && previousEnd <= gapStart
      ? sum + Math.max(0, previous.missingMs)
      : sum;
  }, 0);
  return `约 ${hms(gapStart - start - previousMissingMs)}`;
}
