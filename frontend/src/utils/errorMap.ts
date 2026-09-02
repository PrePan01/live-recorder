import type { ErrorCode } from '../types/error';

/** 契约 v1.1：18 码全集。info 级提示码（STREAM_FORMAT_CHANGED / QUALITY_DOWNGRADED）仅展示，不渲染重试。 */
const ERROR_MAP: Partial<Record<ErrorCode, string>> = {
  ROOM_LINK_INVALID: '链接无效或平台不支持，请检查后重试',
  ROOM_LINK_DUPLICATE: '该直播间已存在',
  PLATFORM_ACCESS_RESTRICTED: '平台访问受限，请检查 Cookie 配置',
  PLATFORM_CHANGED: '平台有变动，等待适配更新',
  DIRECTORY_NOT_WRITABLE: '目录不可写，请检查权限',
  DISK_SPACE_INSUFFICIENT: '磁盘空间不足，无法开始录制',
  CONCURRENT_LIMIT_REACHED: '并发录制数已达上限',
  RECORDING_START_FAILED: '录制启动失败',
  STREAM_DISCONNECTED_RECONNECT_EXHAUSTED: '断流重连次数已耗尽',
  SMTP_SEND_FAILED: '邮件发送失败，请检查 SMTP 配置',
  SERVICE_UNAVAILABLE: '服务不可用',
  NETWORK_UNAVAILABLE: '网络不可用',
  RECORDING_FILE_CORRUPTED: '录制文件损坏',
  CONFIG_LOAD_FAILED: '配置加载失败',
  // RESOURCE_NOT_FOUND 不设固定文案：v1.2 口径 FE 直接渲染服务端 message
  STREAM_FORMAT_CHANGED: '流格式变更，已自动切换续录',
  PREVIEW_LIMIT_REACHED: '预览数已达上限（4 路）',
  PREVIEW_NOT_RECORDING: '当前未在录制，无法预览',
  QUALITY_DOWNGRADED: '清晰度已自动降级',
};

export function describeError(code: ErrorCode | undefined, fallback?: string): string {
  if (code && ERROR_MAP[code]) return ERROR_MAP[code];
  return fallback ?? '操作失败，请稍后重试';
}
