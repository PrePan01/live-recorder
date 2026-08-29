import { http } from './client';
import type { RecordingSchedule, ScheduleInput } from '../types/schedule';

export async function fetchSchedules(roomId: string): Promise<RecordingSchedule[]> {
  const { data } = await http.get<{ schedules: RecordingSchedule[] }>(`/rooms/${roomId}/schedules`);
  return data.schedules;
}

export async function createSchedule(roomId: string, input: ScheduleInput): Promise<RecordingSchedule> {
  const { data } = await http.post<{ schedule: RecordingSchedule }>(`/rooms/${roomId}/schedules`, input);
  return data.schedule;
}

export async function updateSchedule(
  roomId: string,
  scheduleId: string,
  input: ScheduleInput,
): Promise<RecordingSchedule> {
  const { data } = await http.patch<{ schedule: RecordingSchedule }>(`/rooms/${roomId}/schedules/${scheduleId}`, input);
  return data.schedule;
}

export async function deleteSchedule(roomId: string, scheduleId: string): Promise<void> {
  await http.delete(`/rooms/${roomId}/schedules/${scheduleId}`);
}