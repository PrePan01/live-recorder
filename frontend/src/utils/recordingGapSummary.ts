import type { RecordingGap } from "../types/recording";

/** 主表总量包含末尾静默及未单独存证的短中断，明细不一定覆盖全部缺失。 */
export function recordingGapSummary(missingMs: number, gaps: RecordingGap[]) {
  const detailedMs = gaps.reduce((sum, gap) => sum + gap.missingMs, 0);
  return {
    missingSeconds: Math.round(missingMs / 1000),
    unlistedSeconds: Math.round(Math.max(0, missingMs - detailedMs) / 1000),
  };
}
