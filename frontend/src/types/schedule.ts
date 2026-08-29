export interface RecordingSchedule {
  id: string;
  roomId: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  daysOfWeek: number[];
  startTime: string;
  endTime?: string | null;
  timezone?: string;
  enabled?: boolean;
}