export type AlertLevel = 'info' | 'warning' | 'error';

export type AlertSource = 'network' | 'platform' | 'disk' | 'smtp' | 'recorder' | 'service';

/** 与 §5 已评审 alerts 表一致；错误码断言走 room.lastError / recording.failureReason。 */
export interface Alert {
  id: string;
  level: AlertLevel;
  source: string;
  message: string;
  occurredAt: string;
  resolved: boolean;
  /** 关联房间（失败重试定位用），无则 null。 */
  roomId: string | null;
  /** 结构化错误码（如 RECORDING_START_FAILED），无则 null。 */
  errorCode: string | null;
}
