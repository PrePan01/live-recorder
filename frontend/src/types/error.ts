export type ErrorCode =
  | 'ROOM_LINK_INVALID'
  | 'ROOM_LINK_DUPLICATE'
  | 'PLATFORM_ACCESS_RESTRICTED'
  | 'PLATFORM_CHANGED'
  | 'DIRECTORY_NOT_WRITABLE'
  | 'DISK_SPACE_INSUFFICIENT'
  | 'CONCURRENT_LIMIT_REACHED'
  | 'RECORDING_START_FAILED'
  | 'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED'
  | 'SMTP_SEND_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'RECORDING_FILE_CORRUPTED'
  | 'CONFIG_LOAD_FAILED'
  | 'RESOURCE_NOT_FOUND'
  | 'STREAM_FORMAT_CHANGED'
  | 'PREVIEW_LIMIT_REACHED'
  | 'PREVIEW_NOT_RECORDING'
  | 'QUALITY_DOWNGRADED'
  | (string & {});

/** 契约 v1.1：lastError / failureReason 的结构化对象形态 */
export interface ApiErrorEnvelope {
  code: ErrorCode;
  message: string;
  roomId?: string | null;
  recordingId?: string | null;
  occurredAt: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly roomId?: string | null;
  readonly recordingId?: string | null;
  readonly occurredAt?: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(body: ApiErrorEnvelope, status?: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.roomId = body.roomId;
    this.recordingId = body.recordingId;
    this.occurredAt = body.occurredAt;
    this.retryable = body.retryable;
    this.status = status;
  }
}
