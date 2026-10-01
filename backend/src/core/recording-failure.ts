import { AppError, type ErrorCode, type ErrorObject } from "../types/error.js";

/**
 * 录制失败文案
 */
const FAILURE_TEXT: Partial<Record<ErrorCode, string>> = {
  NETWORK_UNAVAILABLE: "网络中断，录制已停止（已录内容已保留）",
  STREAM_URL_EXPIRED: "平台暂时无法提供直播画面，录制已停止（已录内容已保留）",
  PLATFORM_SERVER_ERROR: "直播平台服务异常，录制已停止（已录内容已保留）",
  RECORDING_WRITE_FAILED: "保存录像失败，请检查磁盘空间是否充足、目录是否可写",
  RECORDING_WRITE_SLOW: "磁盘写入过慢（可能磁盘繁忙或空间不足），录制已停止",
  RECORDING_START_TIMEOUT: "等待直播数据超时，录制已停止",
  RECORDING_START_FAILED: "录制出现异常，已停止（已录内容已保留）",
  RECORDING_EMPTY: "未收到任何直播数据，无法生成录像文件",
  RECORDING_FILE_CORRUPTED: "录像文件不完整，播放可能中断或无法拖动进度",
  RECORDING_REMUX_FAILED: "转为 MP4 失败，已保留原始录像文件",
  HIGHLIGHT_EXPORT_FAILED: "精彩时刻导出失败，请重试",
  RECORDING_DIRECTORY_INVALID: "保存目录无效，录制失败",
  DISK_SPACE_INSUFFICIENT: "磁盘空间不足，请及时清理",
  CONCURRENT_LIMIT_REACHED: "录制达到最大并发数量，请在设置内增加最大并发",
};

/** 中断根因简称：用于"…，软件自动重试 N 次仍未恢复"模板，保证最终原因里带上真正的原因。 */
const CAUSE_LABEL: Partial<Record<ErrorCode, string>> = {
  NETWORK_UNAVAILABLE: "网络中断",
  STREAM_URL_EXPIRED: "平台暂时无法提供直播画面",
  PLATFORM_SERVER_ERROR: "直播平台服务异常",
  RECORDING_START_TIMEOUT: "等待直播数据超时",
  RECORDING_START_FAILED: "录制异常",
};

/**
 * 建录像文件失败 → 按 errno 归因：超长名/权限/磁盘满各有各的说法，
 * 不再一律报「保存目录无效」（R-2：用户改不了目录时会被这句带偏排查方向）。
 */
export function fileCreateError(error: unknown, roomId: string): AppError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENAMETOOLONG") {
    return new AppError(
      "RECORDING_DIRECTORY_INVALID",
      "文件名或路径过长，无法保存录像（请缩短房间显示名）",
      { roomId },
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new AppError(
      "DIRECTORY_NOT_WRITABLE",
      "没有保存目录的写入权限，请更换保存目录",
      { roomId },
    );
  }
  if (code === "ENOSPC") {
    return new AppError(
      "DISK_SPACE_INSUFFICIENT",
      "磁盘空间不足，无法创建录像文件",
      { roomId },
    );
  }
  return new AppError("RECORDING_DIRECTORY_INVALID", "保存目录无效，录制失败", {
    roomId,
  });
}

export function failureText(code: ErrorCode, fallbackMessage?: string): string {
  return FAILURE_TEXT[code] ?? fallbackMessage ?? "录制已停止";
}

/** 中断根因简称（"网络中断"这类），用于重试中的告警与最终失败说明。 */
export function causeLabel(code: ErrorCode): string {
  return CAUSE_LABEL[code] ?? "录制异常";
}

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

export function failureCategory(code: ErrorCode): FailureReasonCategory {
  switch (code) {
    case "DISK_SPACE_INSUFFICIENT":
    case "RECORDING_DIRECTORY_INVALID":
    case "DIRECTORY_NOT_WRITABLE":
      return "disk_error";
    case "RECORDING_WRITE_FAILED":
    case "RECORDING_WRITE_SLOW":
      return "write_failed";
    case "RECORDING_START_FAILED":
    case "RECORDING_START_TIMEOUT":
    case "RECORDING_EMPTY":
      return "start_failed";
    case "STREAM_DISCONNECTED_RECONNECT_EXHAUSTED":
      return "stream_timeout";
    case "NETWORK_UNAVAILABLE":
    case "STREAM_URL_EXPIRED":
      return "network";
    case "PLATFORM_SERVER_ERROR":
    case "PLATFORM_CHANGED":
    case "PLATFORM_ACCESS_RESTRICTED":
    case "DOUYIN_COOKIE_EXPIRED":
    case "ROOM_CONTENT_UNAVAILABLE":
      return "platform";
    case "RECORDING_FILE_CORRUPTED":
    case "RECORDING_REMUX_FAILED":
      return "file_corrupted";
    case "CONCURRENT_LIMIT_REACHED":
      return "concurrency";
    default:
      return "unknown";
  }
}

/** 失败原因落库前统一富化：带上分类枚举（原有 details 与 technicalMessage 保留）。 */
export function withReasonCategory(err: ErrorObject): ErrorObject {
  return {
    ...err,
    details: {
      ...(err.details ?? {}),
      reasonCategory: failureCategory(err.code),
    },
  };
}

/** 重连/重试耗尽：把真正的原因带进最终说明，而不是只报"次数已耗尽"。 */
export function reconnectExhausted(
  cause: ErrorObject,
  attempts: number,
): AppError {
  const label = causeLabel(cause.code);
  return new AppError(
    "STREAM_DISCONNECTED_RECONNECT_EXHAUSTED",
    `${label}，软件自动重试 ${attempts} 次仍未恢复，录制已停止`,
    {
      roomId: cause.roomId,
      recordingId: cause.recordingId,
      retryable: true,
      details: {
        rootCauseCode: cause.code,
        rootCauseMessage: cause.message,
        attempts,
      },
    },
  );
}

/** 把引擎抛出的技术性原因换成人话，原文放进 details 备查。 */
export function humanizeFailure(err: ErrorObject): AppError {
  // 技术原文不直接给用户：内部错误换成人话，原文进 details 供悬浮/诊断包；
  // 其余错误的消息在产生点已人话化，直接用。
  const message =
    err.code === "RECORDING_START_FAILED"
      ? "软件内部数据错误，建议重启应用；若反复出现请导出诊断包反馈"
      : err.message || failureText(err.code);
  return new AppError(err.code, message, {
    roomId: err.roomId,
    recordingId: err.recordingId,
    retryable: err.retryable,
    occurredAt: err.occurredAt,
    details: {
      ...(err.details ?? {}),
      technicalMessage: err.message,
      reasonCategory: failureCategory(err.code),
    },
  });
}

/** 写盘类错误：与网络无关，重试无意义，必须直接终止并说清是磁盘问题。 */
export function writeFailure(
  err: unknown,
  context: { roomId?: string; recordingId?: string } = {},
): AppError {
  if (err instanceof AppError) return err;
  const message = (err as Error)?.message ?? "";
  if (/ENODEV|ENXIO/.test(message)) {
    // ENODEV/ENXIO 才表示设备不可用；仍不能断言是被拔出，也可能是供电、
    // 集线器或控制器重置。最终是否停止由上层自动恢复策略决定。
    return new AppError(
      "RECORDING_WRITE_FAILED",
      "存储设备不可用（可能已断开），正在尝试恢复录制",
      { ...context, retryable: false, details: { cause: message } },
    );
  }
  if (/\bEIO\b/.test(message)) {
    // EIO 仅表示 I/O 写入失败，不能据此推断 U 盘被拔出；还可能是文件系统、
    // 供电或介质/控制器的短暂异常。
    return new AppError(
      "RECORDING_WRITE_FAILED",
      "存储设备写入失败（EIO），正在尝试恢复录制",
      { ...context, retryable: false, details: { cause: message } },
    );
  }
  if (message.includes("写入过慢")) {
    return new AppError(
      "RECORDING_WRITE_SLOW",
      failureText("RECORDING_WRITE_SLOW"),
      { ...context, retryable: false },
    );
  }
  return new AppError(
    "RECORDING_WRITE_FAILED",
    failureText("RECORDING_WRITE_FAILED"),
    {
      ...context,
      retryable: false,
      details: { cause: message },
    },
  );
}

/**
 * 写盘类错误族（自动恢复录制的准入判定，PrePan 需求①）：磁盘瞬时故障
 * （USB 抖动/休眠唤醒）值得退避重启；其他非可重试错误维持直接收尾。
 */
export function isWriteFailure(error: ErrorObject): boolean {
  return (
    error.code === "RECORDING_WRITE_FAILED" ||
    error.code === "RECORDING_WRITE_SLOW"
  );
}

/** 写盘失败自动恢复耗尽：终停必带明确原因（根因+尝试次数进 details 备查）。 */
export function writeRestartExhausted(
  cause: ErrorObject,
  attempts: number,
): AppError {
  const label = isWriteFailure(cause)
    ? "存储设备读写失败（可能已断开或空间不足）"
    : causeLabel(cause.code);
  return new AppError(
    "RECORDING_WRITE_FAILED",
    `${label}，自动恢复录制 ${attempts} 次仍未成功，已保留已录内容`,
    {
      roomId: cause.roomId,
      recordingId: cause.recordingId,
      retryable: false,
      details: {
        rootCauseCode: cause.code,
        rootCauseMessage: cause.message,
        attempts,
      },
    },
  );
}
