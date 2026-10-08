/**
 * 缺口归因的人话兜底（evidence 无因时按 kind 粗归因；判不出=原因未知）。
 */
const KIND_FALLBACK: Record<string, string> = {
  system_sleep: "系统休眠期间暂停录制",
  source_stall: "源端长静默（直播源长时间无数据）",
  stream_disconnect: "直播连接中断",
  recording_tail: "录制结束前的缺失",
};

/** 通用空话（未记因）——比较与返回必须同源，防标点漂移致回退失效。 */
export const GENERIC_GAP_REASON = "直播数据传输中断，具体原因未记录。";

export function recordingGapKindText(kind: string): string {
  return KIND_FALLBACK[kind] ?? "原因未知";
}
