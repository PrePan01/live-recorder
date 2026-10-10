import { GENERIC_GAP_REASON } from "./recordingGapKindText";
import type { RecordingGap } from "../types/recording";

const CAUSE_TEXT: Record<string, string> = {
  NETWORK_UNAVAILABLE: "网络或直播平台连接异常，暂时无法接收直播数据。",
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: "直播连接中断，重连期间未收到直播数据。",
  STREAM_URL_EXPIRED: "直播地址已失效，重新获取直播地址期间录制中断。",
  RECORDING_START_TIMEOUT: "等待直播数据超时，录制暂时中断。",
  RECORDING_EMPTY: "未收到直播数据，录制暂时中断。",
  RECORDING_WRITE_FAILED: "录像保存失败，可能是存储设备断开或无法写入。",
  RECORDING_WRITE_SLOW: "存储设备写入过慢，导致录制中断。",
  DISK_SPACE_INSUFFICIENT: "存储空间不足，导致录像无法继续保存。",
  RECORDING_DIRECTORY_INVALID: "录像保存目录不可用，导致录制中断。",
  DIRECTORY_NOT_WRITABLE: "录像保存目录无法写入，导致录制中断。",
  PLATFORM_SERVER_ERROR: "直播平台服务异常，暂时无法提供直播数据。",
  PLATFORM_CHANGED: "直播平台接口发生变化，暂时无法获取直播数据。",
  PLATFORM_ACCESS_RESTRICTED: "直播平台限制了访问，暂时无法获取直播数据。",
  DOUYIN_COOKIE_EXPIRED: "抖音授权已失效，暂时无法获取直播数据。",
  ROOM_CONTENT_UNAVAILABLE: "直播间内容暂时不可用，无法获取直播数据。",
  STREAM_FORMAT_CHANGED: "直播格式发生变化，切换录制方式期间出现中断。",
};

function readCauseCode(evidence: string | null): string | undefined {
  if (!evidence) return;
  try {
    const parsed: unknown = JSON.parse(evidence);
    if (!parsed || typeof parsed !== "object" || !("cause" in parsed)) return;
    const cause = parsed.cause;
    if (!cause || typeof cause !== "object" || !("code" in cause)) return;
    return typeof cause.code === "string" ? cause.code : undefined;
  } catch {
    return;
  }
}

/** 只展示已知含义，旧证据或未知错误的技术原文不直接出现在用户界面。 */
export function recordingGapText(gap: RecordingGap): { status: string; reason: string } {
  if (gap.kind === "system_sleep") {
    return { status: "系统唤醒", reason: "系统休眠，录制中断" };
  }
  if (gap.kind === "recording_tail") {
    return {
      status: "录制结束",
      reason: "录制结束前持续未收到直播数据，这段时间未录入录像。",
    };
  }
  if (gap.kind === "service_restart") {
    return { status: "恢复录制", reason: "录制服务重启，期间的直播内容未录入录像。" };
  }
  const code = readCauseCode(gap.evidence);
  const reason = code && Object.hasOwn(CAUSE_TEXT, code) ? CAUSE_TEXT[code] : undefined;
  return {
    status: gap.kind === "stream_disconnect" ? "恢复录制" : "中断记录",
    reason: reason ?? GENERIC_GAP_REASON,
  };
}
