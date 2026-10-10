import type { Recording } from "../types/recording";

/** 校验结论与中断记录一起判断；旧数据未知时不承诺完整。 */
export function recordingOutcome(recording: Recording): string | null {
  if (
    !["completed", "failed", "processing", "awaiting_confirmation"].includes(
      recording.state,
    )
  )
    return null;
  const missingMs = recording.gapSummary?.totalMissingMs ?? recording.missingMs;
  const count = recording.gapSummary?.gapCount ?? recording.gapCount;
  if ((missingMs ?? 0) > 0 || (count ?? 0) > 0)
    return `${count != null ? `${count} 次中断，` : ""}${recording.gapSummary?.estimated ? "约 " : ""}累计缺失 ${Math.ceil((missingMs ?? 0) / 1000)} 秒`;
  if (recording.integrityState === "failed" || recording.integrity === "failed")
    return "文件校验未通过";
  const verified =
    recording.integrityState === "ok" || recording.integrity === "verified";
  const interrupted = ["interrupted", "service_restart"].includes(
    recording.endReason ?? "",
  );
  if (verified && count === 0 && missingMs === 0 && !interrupted)
    return "完整录制";
  return verified ? "文件可播放，完整性记录待确认" : "录制结果待校验";
}
