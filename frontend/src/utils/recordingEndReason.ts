import type { RecordingEndReason } from "../types/recording";

/**
 * 录制结束原因的中文说法：让用户一眼看出这次是怎么停的
 * （正常收尾 / 手动停止 / 中途中断 / 重启中断），而不是所有情况都只有一句「录制完成」。
 */
const END_REASON_TEXT: Record<RecordingEndReason, string> = {
  natural: "直播结束",
  stopped: "手动停止",
  interrupted: "中途中断",
  service_restart: "重启中断",
};

/** 进行中的录制没有结束原因；未知取值也返回 null，绝不把原始枚举漏给界面。 */
export function describeEndReason(
  reason: RecordingEndReason | null | undefined,
): string | null {
  if (!reason) return null;
  return END_REASON_TEXT[reason] ?? null;
}

/** 中断类结束（内容可能不完整）在界面上要区别于正常/手动结束。 */
export function isInterruptedEnd(
  reason: RecordingEndReason | null | undefined,
): boolean {
  return reason === "interrupted" || reason === "service_restart";
}
