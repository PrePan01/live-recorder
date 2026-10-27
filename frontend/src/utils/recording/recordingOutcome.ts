// 综合文件校验和中断记录，生成录像是否完整的结果说明。
import type { Recording } from "../../types/recording";

function verified(recording: Recording): boolean {
  return recording.integrityState != null
    ? recording.integrityState === "ok"
    : recording.integrity === "verified";
}

/** 校验通过的历史记录缺少中断数据时，按无中断兼容展示。 */
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
  if (
    recording.integrityState === "failed" ||
    (recording.integrityState == null && recording.integrity === "failed")
  )
    return "文件校验未通过";
  const isVerified = verified(recording);
  const interrupted = ["interrupted", "service_restart"].includes(
    recording.endReason ?? "",
  );
  if (
    isVerified &&
    (count ?? 0) === 0 &&
    (missingMs ?? 0) === 0 &&
    !interrupted
  )
    return "完整录制";
  return isVerified ? "文件可播放，但无法确认是否完整" : "录制结果待校验";
}

/** 标签与详细说明分开判断；校验结论仍优先使用当前状态，再回退旧字段。 */
export function recordingIntegrityLabel(
  recording: Recording,
): "完整" | "已校验，有中断" | "未知" | null {
  const outcome = recordingOutcome(recording);
  if (outcome === null) return null;
  // Active checks and explicit unavailable results retain their dedicated tags.
  if (recording.integrityState != null && recording.integrityState !== "ok")
    return null;
  // 当前细分状态优先，旧记录才回退三态，避免失败被中断摘要掩盖。
  if (recording.integrityState == null && recording.integrity === "failed")
    return null;
  if (outcome === "完整录制") return "完整";
  if (
    (recording.gapSummary?.totalMissingMs ?? recording.missingMs ?? 0) > 0 ||
    (recording.gapSummary?.gapCount ?? recording.gapCount ?? 0) > 0
  ) {
    return verified(recording) ? "已校验，有中断" : "未知";
  }
  if (
    outcome === "文件可播放，但无法确认是否完整" ||
    outcome === "录制结果待校验"
  )
    return "未知";
  return null;
}
