export type AlertLevel = 'info' | 'warning' | 'error';

export interface AlertFailureReason {
  code: string;
  message: string;
}

export interface Alert {
  id: string;
  level: AlertLevel;
  source: string;
  message: string;
  occurredAt: string;
  resolved: boolean;
  roomId?: string;
  failureReason?: AlertFailureReason | null;
}
