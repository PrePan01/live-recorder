const KIND_FALLBACK: Record<string, string> = {
  system_sleep: "系统休眠期间暂停录制",
  source_stall: "源端长静默（直播源长时间无数据）",
  stream_disconnect: "直播连接中断",
  recording_tail: "录制结束前的缺失",
};

export const GENERIC_GAP_REASON = "直播数据传输中断，具体原因未记录。";

export function recordingGapKindText(kind: string): string {
  return KIND_FALLBACK[kind] ?? "原因未知";
}
