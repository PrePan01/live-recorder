export type AlertLevel = 'info' | 'warning' | 'error';

export interface Alert {
  id: string;
  level: AlertLevel;
  source: string;
  message: string;
  occurredAt: string;
  resolved: boolean;
}
