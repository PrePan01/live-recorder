import type { DB } from '../connection.js';
import type { RecordingSchedule, ScheduleDay } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

interface ScheduleRow {
  id: string;
  room_id: string;
  days_of_week: string;
  start_time: string;
  end_time: string | null;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseDays(raw: string): ScheduleDay[] {
  try {
    const arr = JSON.parse(raw) as number[];
    return arr.map((d) => d as ScheduleDay);
  } catch {
    return [];
  }
}

function rowToSchedule(row: ScheduleRow): RecordingSchedule {
  return {
    id: row.id,
    roomId: row.room_id,
    daysOfWeek: parseDays(row.days_of_week),
    startTime: row.start_time,
    endTime: row.end_time,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScheduleRepository {
  private readonly enabledRooms = new Set<string>();

  constructor(private db: DB) {
    const rows = db.prepare('SELECT DISTINCT room_id FROM recording_schedules WHERE enabled = 1').all() as { room_id: string }[];
    for (const row of rows) this.enabledRooms.add(row.room_id);
  }

  hasEnabledForRoom(roomId: string): boolean {
    return this.enabledRooms.has(roomId);
  }

  clearIndex(): void {
    this.enabledRooms.clear();
  }

  private refreshEnabledRoom(roomId: string): void {
    const enabled = this.db.prepare('SELECT 1 FROM recording_schedules WHERE room_id = ? AND enabled = 1 LIMIT 1').get(roomId);
    if (enabled) this.enabledRooms.add(roomId);
    else this.enabledRooms.delete(roomId);
  }

  create(input: { roomId: string; daysOfWeek: ScheduleDay[]; startTime: string; endTime?: string | null; timezone: string; enabled?: boolean }): RecordingSchedule {
    const id = newId('sch');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO recording_schedules (id, room_id, days_of_week, start_time, end_time, timezone, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, input.roomId, JSON.stringify(input.daysOfWeek), input.startTime, input.endTime ?? null, input.timezone, input.enabled === false ? 0 : 1, now, now);
    if (input.enabled !== false) this.enabledRooms.add(input.roomId);
    return this.get(id)!;
  }

  get(id: string): RecordingSchedule | null {
    const row = this.db.prepare('SELECT * FROM recording_schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  listForRoom(roomId: string): RecordingSchedule[] {
    const rows = this.db.prepare('SELECT * FROM recording_schedules WHERE room_id = ? ORDER BY start_time ASC').all(roomId) as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  listEnabled(): RecordingSchedule[] {
    const rows = this.db.prepare('SELECT * FROM recording_schedules WHERE enabled = 1').all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  update(id: string, patch: Partial<Pick<RecordingSchedule, 'daysOfWeek' | 'startTime' | 'endTime' | 'timezone' | 'enabled' | 'nextRunAt'>>): RecordingSchedule {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.daysOfWeek !== undefined) {
      sets.push('days_of_week = ?');
      params.push(JSON.stringify(patch.daysOfWeek));
    }
    if (patch.startTime !== undefined) {
      sets.push('start_time = ?');
      params.push(patch.startTime);
    }
    if (patch.endTime !== undefined) {
      sets.push('end_time = ?');
      params.push(patch.endTime);
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?');
      params.push(patch.timezone);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.nextRunAt !== undefined) {
      sets.push('next_run_at = ?');
      params.push(patch.nextRunAt);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      this.db.prepare(`UPDATE recording_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    const schedule = this.get(id)!;
    if (patch.enabled !== undefined && schedule) {
      if (schedule.enabled) this.enabledRooms.add(schedule.roomId);
      else this.refreshEnabledRoom(schedule.roomId);
    }
    return schedule;
  }

  remove(id: string): void {
    const deleted = this.db.prepare('DELETE FROM recording_schedules WHERE id = ? RETURNING room_id, enabled').get(id) as Pick<ScheduleRow, 'room_id' | 'enabled'> | undefined;
    if (deleted?.enabled === 1) this.refreshEnabledRoom(deleted.room_id);
  }
}
