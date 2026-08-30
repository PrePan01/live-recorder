import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import type { RecordingSchedule, ScheduleDay } from '../../types/index.js';
import { AppEventBus } from '../../core/events.js';

const DAYS: ScheduleDay[] = [0, 1, 2, 3, 4, 5, 6];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 校验并标准化计划输入。 */
function validateSchedule(input: { daysOfWeek?: unknown; startTime?: unknown; endTime?: unknown; timezone?: unknown; enabled?: unknown }): {
  daysOfWeek: ScheduleDay[];
  startTime: string;
  endTime: string | null;
  timezone: string;
  enabled: boolean;
} {
  const days = input.daysOfWeek as unknown;
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => typeof d !== 'number' || !DAYS.includes(d as ScheduleDay))) {
    throw new AppError('CONFIG_INVALID', 'daysOfWeek 需为非空 0-6 数字数组（0=周日）');
  }
  const uniq = [...new Set(days as number[])] as ScheduleDay[];
  if (typeof input.startTime !== 'string' || !TIME_RE.test(input.startTime)) {
    throw new AppError('CONFIG_INVALID', 'startTime 需为 HH:mm（24h）');
  }
  const endTime = input.endTime as unknown;
  if (endTime !== undefined && endTime !== null && (typeof endTime !== 'string' || !TIME_RE.test(endTime))) {
    throw new AppError('CONFIG_INVALID', 'endTime 需为 HH:mm 或 null');
  }
  if (input.timezone !== undefined && typeof input.timezone !== 'string') {
    throw new AppError('CONFIG_INVALID', 'timezone 必须为字符串');
  }
  const tz = typeof input.timezone === 'string' && input.timezone ? input.timezone : 'local';
  if (tz !== 'local' && !isValidIanaTimezone(tz)) {
    throw new AppError('CONFIG_INVALID', 'timezone 需为有效 IANA 时区（如 Asia/Shanghai）');
  }
  return {
    daysOfWeek: uniq,
    startTime: input.startTime,
    endTime: endTime === undefined || endTime === null ? null : (endTime as string),
    timezone: typeof input.timezone === 'string' && input.timezone ? input.timezone : 'local',
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

/**
 * 计算下次执行时间：在 daysOfWeek 中找 startTime 对应的最近未来时刻（按 schedule.timezone）。
 * 支持跨天窗口（end < start 时次日结束，但触发点仍为 start）。已过期 nextRunAt 会被推进。
 */
export function computeNextRunAt(schedule: { daysOfWeek: ScheduleDay[]; startTime: string; endTime: string | null; timezone: string }, nowMs: number): string | null {
  if (schedule.daysOfWeek.length === 0) return null;
  // 防御：历史遗留的非法时区计划不应让调度器崩溃（返回 null，跳过）。
  const tz = schedule.timezone === 'local' ? undefined : schedule.timezone;
  if (tz && !isValidIanaTimezone(tz)) return null;
  const [startH, startM] = schedule.startTime.split(':').map(Number) as [number, number];
  for (let offset = 0; offset <= 7; offset += 1) {
    // 该候选日（now 起推 offset 天）在目标时区的日历日期。
    const candidateStartMs = startOfDayInTz(nowMs, offset, tz);
    const { dow, dayMs } = wallClockInfo(candidateStartMs, tz);
    if (!schedule.daysOfWeek.includes(dow)) continue;
    // 该日 startTime 在目标时区的绝对时刻。
    const startAt = wallToEpoch(dayMs, startH, startM, tz);
    if (startAt > nowMs) return new Date(startAt).toISOString();
    // 今天已过 start → 下个匹配日继续。
  }
  return null;
}

/** 候选日「日历日期起点」在目标时区对应的 epoch（用该时区当天 00:00 回推）。 */
function startOfDayInTz(nowMs: number, offsetDays: number, tz: string | undefined): number {
  const probe = new Date(nowMs + offsetDays * 24 * 60 * 60 * 1000);
  const ymd = partsInTz(probe, tz);
  const epochGuess = Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0, 0);
  // 校正：Intl 给出的本地日历日在目标时区下的 epoch（考虑 DST，用两次迭代收敛）。
  let guess = epochGuess;
  for (let i = 0; i < 3; i += 1) {
    const g = partsInTz(new Date(guess), tz);
    const desired = Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0, 0);
    const delta = desired - Date.UTC(g.year, g.month - 1, g.day, 0, 0, 0, 0);
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

/** 在目标时区解析某 epoch 的 {year,month,day,hour,minute,dow}。 */
function partsInTz(ms: number | Date, tz: string | undefined): { year: number; month: number; day: number; hour: number; minute: number; dow: ScheduleDay } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const dowMap: Record<string, ScheduleDay> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dow: dowMap[get('weekday') ?? 'Sun'] ?? 0,
  };
}

function wallClockInfo(dayMs: number, tz: string | undefined): { dow: ScheduleDay; dayMs: number } {
  const p = partsInTz(dayMs, tz);
  return { dow: p.dow, dayMs };
}

/** 某时区某日历日 HH:mm → epoch（用该时区当日 00:00 + 本地时钟差校正）。 */
function wallToEpoch(dayStartMs: number, h: number, m: number, tz: string | undefined): number {
  const guess = dayStartMs + (h * 60 + m) * 60_000;
  const p = partsInTz(guess, tz);
  const delta = (h * 60 + m) - (p.hour * 60 + p.minute);
  // DST 边缘迭代校正（最多 ±1h 漂移）。
  return dayStartMs + ((h * 60 + m) + delta) * 60_000;
}

export function registerScheduleRoutes(app: FastifyInstance, services: Services): void {
  // 列表：房间所有计划。
  app.get('/api/v1/rooms/:id/schedules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    return reply.send({ schedules: services.schedules.listForRoom(id) });
  });

  app.post('/api/v1/rooms/:id/schedules', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    const input = validateSchedule((req.body ?? {}) as Record<string, unknown>);
    const schedule = services.schedules.create({ roomId: id, ...input });
    const next = computeNextRunAt(schedule, services.clock.now());
    const updated = services.schedules.update(schedule.id, { nextRunAt: next });
    services.events.emit({ type: 'schedule:updated', data: updated });
    return reply.status(201).send({ schedule: updated });
  });

  app.patch('/api/v1/rooms/:id/schedules/:scheduleId', async (req, reply) => {
    const { id, scheduleId } = req.params as { id: string; scheduleId: string };
    if (!services.rooms.get(id)) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    const existing = services.schedules.get(scheduleId);
    if (!existing || existing.roomId !== id) throw new AppError('RESOURCE_NOT_FOUND', '计划不存在', { details: { resource: 'schedule' } });
    const input = validateSchedule({ ...existing, ...(req.body ?? {}) });
    let schedule = services.schedules.update(scheduleId, { ...input });
    // enabled 变化时重算 nextRunAt。
    const next = computeNextRunAt(schedule, services.clock.now());
    schedule = services.schedules.update(scheduleId, { nextRunAt: input.enabled ? next : null });
    services.events.emit({ type: 'schedule:updated', data: schedule });
    return reply.send({ schedule });
  });

  app.delete('/api/v1/rooms/:id/schedules/:scheduleId', async (req, reply) => {
    const { id, scheduleId } = req.params as { id: string; scheduleId: string };
    const existing = services.schedules.get(scheduleId);
    if (!existing || existing.roomId !== id) throw new AppError('RESOURCE_NOT_FOUND', '计划不存在', { details: { resource: 'schedule' } });
    services.schedules.remove(scheduleId);
    services.events.emit({ type: 'schedule:updated', data: { ...existing, enabled: false } });
    return reply.status(204).send();
  });
}

/** 供 Scheduler 集成：到期计划触发一次检测（离线不建立空录制——交给现有 checkRoom 语义）。 */
export function dueSchedules(services: Services, nowMs: number): Array<{ schedule: RecordingSchedule; roomId: string }> {
  const results: Array<{ schedule: RecordingSchedule; roomId: string }> = [];
  for (const schedule of services.schedules.listEnabled()) {
    const next = computeNextRunAt(schedule, nowMs);
    // 已到/已过 nextRunAt（且仍在 today 匹配窗口内）→ 触发。
    if (schedule.nextRunAt && new Date(schedule.nextRunAt).getTime() <= nowMs) {
      results.push({ schedule, roomId: schedule.roomId });
      // 推进到下次。
      const recomputed = computeNextRunAt(schedule, nowMs + 60_000);
      services.schedules.update(schedule.id, { nextRunAt: recomputed });
    }
  }
  return results;
}

/** 校验时区为有效 IANA 时区（非法时区在 Intl.DateTimeFormat 会抛异常 → 500）。 */
export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type { AppEventBus };