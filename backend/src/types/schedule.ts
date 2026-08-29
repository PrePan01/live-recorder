export type ScheduleDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface RecordingSchedule {
  id: string;
  roomId: string;
  /** ISO 星期：0=周日 ... 6=周六。 */
  daysOfWeek: ScheduleDay[];
  /** HH:mm（24h，本机/指定时区）。 */
  startTime: string;
  /** HH:mm（24h，可跨天：end < start 表示次日结束）。 */
  endTime: string | null;
  timezone: string;
  enabled: boolean;
  /** 下次应执行时间（ISO，由服务端计算；enabled 且 future）。 */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}