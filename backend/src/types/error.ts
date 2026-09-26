export type ErrorCode =
  | 'ROOM_LINK_INVALID'
  | 'ROOM_LINK_DUPLICATE'
  | 'ROOM_CONTENT_UNAVAILABLE'
  | 'PLATFORM_ACCESS_RESTRICTED'
  | 'DOUYIN_COOKIE_EXPIRED'
  | 'PLATFORM_CHANGED'
  | 'DIRECTORY_NOT_WRITABLE'
  | 'RECORDING_DIRECTORY_INVALID'
  | 'DISK_SPACE_INSUFFICIENT'
  | 'CONCURRENT_LIMIT_REACHED'
  | 'RECORDING_NOT_AVAILABLE'
  | 'RECORDING_START_FAILED'
  | 'RECORDING_START_TIMEOUT'
  | 'RECORDING_WRITE_FAILED'
  | 'RECORDING_WRITE_SLOW'
  | 'STREAM_URL_EXPIRED'
  | 'PLATFORM_SERVER_ERROR'
  | 'HIGHLIGHT_EXPORT_FAILED'
  | 'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED'
  | 'SMTP_SEND_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'RECORDING_FILE_CORRUPTED'
  | 'CONFIG_LOAD_FAILED'
  | 'STREAM_FORMAT_CHANGED'
  | 'PREVIEW_LIMIT_REACHED'
  | 'RESOURCE_NOT_FOUND'
  | 'PREVIEW_NOT_RECORDING'
  | 'QUALITY_DOWNGRADED'
  | 'TAG_INVALID'
  | 'SEARCH_QUERY_INVALID'
  | 'SEARCH_TIMEOUT'
  | 'DIAGNOSTIC_ACTION_INVALID'
  | 'DIAGNOSTIC_CONFLICT'
  | 'PIPELINE_CONFIG_INVALID'
  | 'CHECK_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_EXPORT_FAILED'
  | 'RECORDING_EMPTY'
  | 'RECORDING_REMUX_FAILED';

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  roomId: string | null;
  recordingId: string | null;
  occurredAt: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly roomId: string | null;
  readonly recordingId: string | null;
  readonly retryable: boolean;
  readonly occurredAt: string;
  details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      roomId?: string | null;
      recordingId?: string | null;
      retryable?: boolean;
      occurredAt?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.message = message;
    this.roomId = options.roomId ?? null;
    this.recordingId = options.recordingId ?? null;
    this.retryable = options.retryable ?? false;
    this.occurredAt = options.occurredAt ?? new Date().toISOString();
    if (options.details !== undefined) this.details = options.details;
  }

  toObject(): ErrorObject {
    const obj: ErrorObject = {
      code: this.code,
      message: this.message,
      roomId: this.roomId,
      recordingId: this.recordingId,
      occurredAt: this.occurredAt,
      retryable: this.retryable,
    };
    if (this.details !== undefined) obj.details = this.details;
    return obj;
  }

  static fromObject(obj: ErrorObject): AppError {
    const error = new AppError(obj.code, obj.message, {
      roomId: obj.roomId,
      recordingId: obj.recordingId,
      retryable: obj.retryable,
      occurredAt: obj.occurredAt,
    });
    if (obj.details !== undefined) error.details = obj.details;
    return error;
  }
}

/**
 * 13 个曾缺中文兜底的错误码默认文案（#20 后端面）：投递处未带 message 时由 errorHandler 补齐，
 * 保证前端 describeError 永远能拿到人话，而不是空串或英文技术词。
 */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  ROOM_CONTENT_UNAVAILABLE: '直播间内容暂不可用，请稍后再试',
  RECORDING_NOT_AVAILABLE: '录像暂不可用，可能仍在处理中',
  RESOURCE_NOT_FOUND: '请求的资源不存在',
  TAG_INVALID: '标签不合法',
  SEARCH_QUERY_INVALID: '搜索条件不合法',
  SEARCH_TIMEOUT: '搜索超时，请缩小范围后重试',
  DIAGNOSTIC_ACTION_INVALID: '诊断操作不合法',
  DIAGNOSTIC_CONFLICT: '诊断正在进行中，请稍后再试',
  PIPELINE_CONFIG_INVALID: '管线配置不合法',
  CHECK_FAILED: '检查未通过，请稍后重试',
  CONFIG_INVALID: '配置内容不合法',
  RECORDING_EMPTY: '未收到任何直播数据，无法生成录像文件',
  RECORDING_REMUX_FAILED: '转为 MP4 失败，已保留原始录像文件',
};

export function defaultMessageFor(code: ErrorCode): string | undefined {
  return DEFAULT_MESSAGES[code];
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'ROOM_LINK_INVALID':
    case 'TAG_INVALID':
    case 'SEARCH_QUERY_INVALID':
    case 'PIPELINE_CONFIG_INVALID':
    case 'DIAGNOSTIC_ACTION_INVALID':
    case 'CONFIG_INVALID':
      return 422;
    case 'ROOM_LINK_DUPLICATE':
    case 'DISK_SPACE_INSUFFICIENT':
    case 'CONCURRENT_LIMIT_REACHED':
    case 'RECORDING_NOT_AVAILABLE':
    case 'DIAGNOSTIC_CONFLICT':
      return 409;
    case 'DIRECTORY_NOT_WRITABLE':
    case 'RECORDING_DIRECTORY_INVALID':
      return 422;
    case 'SMTP_SEND_FAILED':
      return 502;
    case 'SEARCH_TIMEOUT':
      return 504;
    case 'CHECK_FAILED':
    case 'SERVICE_UNAVAILABLE':
      return 503;
    case 'CONFIG_LOAD_FAILED':
    case 'CONFIG_EXPORT_FAILED':
      return 500;
    case 'RESOURCE_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}
