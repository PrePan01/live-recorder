import type { ApiErrorEnvelope } from "../types/error";

/** 失败原因分类（与后端枚举同名对齐）。 */
export type FailureReasonCategory =
  | "disk_error"
  | "write_failed"
  | "start_failed"
  | "stream_timeout"
  | "network"
  | "platform"
  | "file_corrupted"
  | "concurrency"
  | "unknown";

type FailureGroup = "disk" | "network" | "file" | "internal";

const CATEGORY_GROUP: Record<FailureReasonCategory, FailureGroup> = {
  disk_error: "disk",
  write_failed: "disk",
  start_failed: "internal",
  stream_timeout: "network",
  network: "network",
  platform: "network",
  file_corrupted: "file",
  concurrency: "internal",
  unknown: "internal",
};

/** 错误码 → 分类（同后端口径）；老数据缺 reasonCategory 时用它归组。 */
const CODE_CATEGORY: Record<string, FailureReasonCategory> = {
  DISK_SPACE_INSUFFICIENT: "disk_error",
  RECORDING_DIRECTORY_INVALID: "disk_error",
  DIRECTORY_NOT_WRITABLE: "disk_error",
  RECORDING_WRITE_FAILED: "write_failed",
  RECORDING_WRITE_SLOW: "write_failed",
  RECORDING_START_FAILED: "start_failed",
  RECORDING_START_TIMEOUT: "start_failed",
  RECORDING_EMPTY: "start_failed",
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: "stream_timeout",
  NETWORK_UNAVAILABLE: "network",
  STREAM_URL_EXPIRED: "network",
  PLATFORM_SERVER_ERROR: "platform",
  PLATFORM_CHANGED: "platform",
  PLATFORM_ACCESS_RESTRICTED: "platform",
  DOUYIN_COOKIE_EXPIRED: "platform",
  ROOM_CONTENT_UNAVAILABLE: "platform",
  RECORDING_FILE_CORRUPTED: "file_corrupted",
  RECORDING_REMUX_FAILED: "file_corrupted",
  CONCURRENT_LIMIT_REACHED: "concurrency",
};

// 启动阶段拿不到直播流归网络文案，其余启动失败按软件内部问题处理。
const CODE_GROUP: Record<string, FailureGroup> = {
  RECORDING_START_TIMEOUT: "network",
  RECORDING_EMPTY: "network",
};

/** 面向用户的人话兜底文案。 */
const GROUP_TEXT: Record<FailureGroup, string> = {
  disk: "存储设备读写失败（可能已断开或空间不足），已保留已录内容",
  network: "网络或平台连接失败，录制已自动尝试恢复",
  file: "录制文件损坏，无法继续处理",
  internal: "软件内部数据错误，建议重启应用；若反复出现请导出诊断包反馈",
};

// 笼统旧文案：换人话兜底，不上屏。
const GENERIC_TEXTS = new Set([
  "录制出现异常，已停止（已录内容已保留）",
  "录制出现异常，已停止",
  "录制异常",
]);

function readDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 录制异常列主文案：后端人话优先，笼统/技术原文换人话兜底。 */
export function failurePrimaryText(
  failure: ApiErrorEnvelope | null | undefined,
): string {
  if (!failure) return GROUP_TEXT.internal;
  const details = failure.details;
  const technical =
    readDetail(details, "technicalMessage") ??
    readDetail(details, "rootCauseMessage");
  const message = failure.message?.trim() ?? "";
  if (message && !GENERIC_TEXTS.has(message) && technical !== message)
    return message;
  const fromDetail = readDetail(details, "reasonCategory");
  const category: FailureReasonCategory =
    fromDetail && fromDetail in CATEGORY_GROUP
      ? (fromDetail as FailureReasonCategory)
      : (CODE_CATEGORY[failure.code] ?? "unknown");
  const group = CODE_GROUP[failure.code] ?? CATEGORY_GROUP[category];
  const rawAttempts = details?.attempts;
  const attempts =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts) && rawAttempts > 0
      ? rawAttempts
      : null;
  const attemptHint =
    attempts && group !== "network"
      ? `；软件已自动恢复 ${attempts} 次仍未成功`
      : "";
  return `${GROUP_TEXT[group]}${attemptHint}`;
}
