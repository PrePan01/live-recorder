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
}
