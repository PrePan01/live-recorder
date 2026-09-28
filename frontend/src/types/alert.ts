export type AlertLevel = 'info' | 'warning' | 'error';

export interface Alert {
  id: string;
  level: AlertLevel;
  source: string;
  message: string;
  occurredAt: string;
  resolved: boolean;
  /** 已读标志（与 resolved=恢复 拆分后的独立语义；旧后端未返回时消费端回退 resolved）。 */
  read?: boolean;
  roomId: string | null;
  errorCode: string | null;
  /** 是否可自动重试（后端分类批次新增；null=未知，按可尝试处理）。 */
  retryable?: boolean | null;
}
