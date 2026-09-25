import type { ErrorCode } from "../types/error";

/**
 * 错误码 → 用户可读文案（兜底用）。
 * 录制失败时后端已经给出针对具体场景的中文说明（写盘失败/地址失效/平台异常等各自一句），
 * describeError 因此优先使用后端 message；这张表只在后端没给 message 时兜底，
 * 避免把更具体的原因盖成一句笼统的"录制启动失败"。
 */
const ERROR_MAP: Partial<Record<ErrorCode, string>> = {
  ROOM_LINK_INVALID: "链接无效或平台不支持，请检查后重试",
  ROOM_LINK_DUPLICATE: "该直播间已存在",
  PLATFORM_ACCESS_RESTRICTED: "平台访问受限，请检查平台授权",
  DOUYIN_COOKIE_EXPIRED: "抖音授权已失效，请到设置页重新授权",
  PLATFORM_CHANGED: "平台接口有变动，请稍后重试",
  DIRECTORY_NOT_WRITABLE: "目录不可写，请检查目录是否正确",
  RECORDING_DIRECTORY_INVALID: "保存目录无效，录制失败",
  DISK_SPACE_INSUFFICIENT: "磁盘空间不足，请及时清理",
  CONCURRENT_LIMIT_REACHED: "录制达到最大并发数量，请在设置内增加最大并发",
  RECORDING_START_FAILED: "录制出现异常，已停止（已录内容已保留）",
  RECORDING_START_TIMEOUT: "等待直播数据超时，录制已停止",
  RECORDING_WRITE_FAILED: "保存录像失败，请检查磁盘空间是否充足、目录是否可写",
  RECORDING_WRITE_SLOW: "磁盘写入过慢（可能磁盘繁忙或空间不足），录制已停止",
  STREAM_URL_EXPIRED: "平台暂时无法提供直播画面，录制已停止（已录内容已保留）",
  PLATFORM_SERVER_ERROR: "直播平台服务异常，录制已停止（已录内容已保留）",
  HIGHLIGHT_EXPORT_FAILED: "精彩时刻导出失败，请重试",
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: "网络中断，软件自动重试多次仍未恢复，录制已停止",
  SMTP_SEND_FAILED: "邮件发送失败，请检查 SMTP 配置",
  SERVICE_UNAVAILABLE: "服务不可用",
  NETWORK_UNAVAILABLE: "网络中断，录制已停止（已录内容已保留）",
  RECORDING_FILE_CORRUPTED: "录像文件不完整，播放可能中断或无法拖动进度",
  CONFIG_LOAD_FAILED: "配置加载失败",
  CONFIG_EXPORT_FAILED: "配置导出失败，请检查所选位置是否可写",
  STREAM_FORMAT_CHANGED: "流格式变更，已自动切换续录",
  PREVIEW_LIMIT_REACHED: "预览数已达上限（9 路）",
  PREVIEW_NOT_RECORDING: "当前未在录制，无法预览",
  QUALITY_DOWNGRADED: "清晰度已自动降级",
  ROOM_CONTENT_UNAVAILABLE: "直播间内容不可用，无法获取直播源",
  RECORDING_NOT_AVAILABLE: "当前没有可录制的直播",
  RESOURCE_NOT_FOUND: "请求的内容不存在",
  TAG_INVALID: "标签名称不符合要求",
  SEARCH_QUERY_INVALID: "搜索内容不合法，请修改关键词",
  SEARCH_TIMEOUT: "搜索超时，请稍后重试",
  DIAGNOSTIC_ACTION_INVALID: "该诊断操作当前不可用",
  DIAGNOSTIC_CONFLICT: "有诊断操作正在进行，请稍候再试",
  PIPELINE_CONFIG_INVALID: "后处理管线配置有误，请到设置页检查",
  CHECK_FAILED: "检测失败，请稍后重试",
  CONFIG_INVALID: "配置内容无效",
  RECORDING_EMPTY: "录制内容为空（未收到直播数据）",
  RECORDING_REMUX_FAILED: "视频转封装失败，可重试或检查磁盘空间",
};

export function describeError(
  code: ErrorCode | undefined,
  fallback?: string,
): string {
  // 后端针对具体场景的说明优先；错误码映射只兜底，不能反过来盖掉更具体的原因。
  return fallback ?? (code ? ERROR_MAP[code] : undefined) ?? "操作失败，请稍后重试";
}
