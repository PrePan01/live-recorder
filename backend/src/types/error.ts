export type ErrorCode =
  | 'ROOM_LINK_INVALID'
  | 'ROOM_LINK_DUPLICATE'
  | 'PLATFORM_ACCESS_RESTRICTED'
  | 'PLATFORM_CHANGED'
  | 'DIRECTORY_NOT_WRITABLE'
  | 'DISK_SPACE_INSUFFICIENT'
  | 'CONCURRENT_LIMIT_REACHED'
  | 'RECORDING_NOT_AVAILABLE'
  | 'RECORDING_START_FAILED'
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
      return 422;
    case 'SMTP_SEND_FAILED':
      return 502;
    case 'SEARCH_TIMEOUT':
      return 504;
    case 'CHECK_FAILED':
    case 'SERVICE_UNAVAILABLE':
      return 503;
    case 'CONFIG_LOAD_FAILED':
      return 500;
    case 'RESOURCE_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}
