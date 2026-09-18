import type { ErrorCode } from "../types/error";

const ERROR_MAP: Partial<Record<ErrorCode, string>> = {
  ROOM_LINK_INVALID: "链接无效或平台不支持，请检查后重试",
  ROOM_LINK_DUPLICATE: "该直播间已存在",
  PLATFORM_ACCESS_RESTRICTED: "平台访问受限，请检查平台授权",
  PLATFORM_CHANGED: "平台有变动，等待适配更新",
  DIRECTORY_NOT_WRITABLE: "目录不可写，请检查目录是否正确",
  RECORDING_DIRECTORY_INVALID: "保存目录无效，录制失败",
  DISK_SPACE_INSUFFICIENT: "磁盘空间不足，无法开始录制",
  CONCURRENT_LIMIT_REACHED: "录制达到最大并发数量，请在设置内增加最大并发",
  RECORDING_START_FAILED: "录制启动失败",
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: "断流重连次数已耗尽",
  SMTP_SEND_FAILED: "邮件发送失败，请检查 SMTP 配置",
  SERVICE_UNAVAILABLE: "服务不可用",
  NETWORK_UNAVAILABLE: "网络不可用",
  RECORDING_FILE_CORRUPTED: "录制文件损坏",
  CONFIG_LOAD_FAILED: "配置加载失败",
  CONFIG_EXPORT_FAILED: "配置导出失败，请检查所选位置是否可写",
  STREAM_FORMAT_CHANGED: "流格式变更，已自动切换续录",
  PREVIEW_LIMIT_REACHED: "预览数已达上限（9 路）",
  PREVIEW_NOT_RECORDING: "当前未在录制，无法预览",
  QUALITY_DOWNGRADED: "清晰度已自动降级",
};

export function describeError(
  code: ErrorCode | undefined,
  fallback?: string,
): string {
  if (code && ERROR_MAP[code]) return ERROR_MAP[code];
  return fallback ?? "操作失败，请稍后重试";
}
