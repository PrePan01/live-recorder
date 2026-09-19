import { AppError, type ErrorCode, type ErrorObject } from '../types/error.js';

/**
 * 录制失败的人话说明：用户看到的失败原因必须能对上是哪种情况，
 * 而不是笼统的"录制失败"或英文错误码。HTTP 状态码、errno 这类技术细节留在 details 里，不上屏。
 */
const FAILURE_TEXT: Partial<Record<ErrorCode, string>> = {
  NETWORK_UNAVAILABLE: '网络中断，录制已停止（已录内容已保留）',
  STREAM_URL_EXPIRED: '平台暂时无法提供直播画面，录制已停止（已录内容已保留）',
  PLATFORM_SERVER_ERROR: '直播平台服务异常，录制已停止（已录内容已保留）',
  RECORDING_WRITE_FAILED: '保存录像失败，请检查磁盘空间是否充足、目录是否可写',
  RECORDING_WRITE_SLOW: '磁盘写入过慢（可能磁盘繁忙或空间不足），录制已停止',
  RECORDING_START_TIMEOUT: '等待直播数据超时，录制已停止',
  RECORDING_START_FAILED: '录制出现异常，已停止（已录内容已保留）',
  RECORDING_EMPTY: '未收到任何直播数据，无法生成录像文件',
  RECORDING_FILE_CORRUPTED: '录像文件不完整，播放可能中断或无法拖动进度',
  RECORDING_REMUX_FAILED: '转为 MP4 失败，已保留原始录像文件',
  HIGHLIGHT_EXPORT_FAILED: '精彩时刻导出失败，请重试',
  RECORDING_DIRECTORY_INVALID: '保存目录无效，录制失败',
  DISK_SPACE_INSUFFICIENT: '磁盘空间不足，无法开始录制',
  CONCURRENT_LIMIT_REACHED: '录制达到最大并发数量，请在设置内增加最大并发',
};

/** 中断根因简称：用于"…，软件自动重试 N 次仍未恢复"模板，保证最终原因里带上真正的原因。 */
const CAUSE_LABEL: Partial<Record<ErrorCode, string>> = {
  NETWORK_UNAVAILABLE: '网络中断',
  STREAM_URL_EXPIRED: '平台暂时无法提供直播画面',
  PLATFORM_SERVER_ERROR: '直播平台服务异常',
  RECORDING_START_TIMEOUT: '等待直播数据超时',
  RECORDING_START_FAILED: '录制异常',
};

export function failureText(code: ErrorCode, fallbackMessage?: string): string {
  return FAILURE_TEXT[code] ?? fallbackMessage ?? '录制已停止';
}

/** 中断根因简称（"网络中断"这类），用于重试中的告警与最终失败说明。 */
export function causeLabel(code: ErrorCode): string {
  return CAUSE_LABEL[code] ?? '录制异常';
}

/** 重连/重试耗尽：把真正的原因带进最终说明，而不是只报"次数已耗尽"。 */
export function reconnectExhausted(cause: ErrorObject, attempts: number): AppError {
  const label = causeLabel(cause.code);
  return new AppError('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED', `${label}，软件自动重试 ${attempts} 次仍未恢复，录制已停止`, {
    roomId: cause.roomId,
    recordingId: cause.recordingId,
    retryable: true,
    details: { rootCauseCode: cause.code, rootCauseMessage: cause.message, attempts },
  });
}

/** 把引擎抛出的技术性原因换成人话，原文放进 details 备查。 */
export function humanizeFailure(err: ErrorObject): AppError {
  return new AppError(err.code, failureText(err.code, err.message), {
    roomId: err.roomId,
    recordingId: err.recordingId,
    retryable: err.retryable,
    occurredAt: err.occurredAt,
    details: { ...(err.details ?? {}), technicalMessage: err.message },
  });
}

/** 写盘类错误：与网络无关，重试无意义，必须直接终止并说清是磁盘问题。 */
export function writeFailure(err: unknown, context: { roomId?: string; recordingId?: string } = {}): AppError {
  if (err instanceof AppError) return err;
  const message = (err as Error)?.message ?? '';
  if (message.includes('写入过慢')) {
    return new AppError('RECORDING_WRITE_SLOW', failureText('RECORDING_WRITE_SLOW'), { ...context, retryable: false });
  }
  return new AppError('RECORDING_WRITE_FAILED', failureText('RECORDING_WRITE_FAILED'), {
    ...context,
    retryable: false,
    details: { cause: message },
  });
}
