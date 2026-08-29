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
    throw new AppError('CONFIG_LOAD_FAILED', 'daysOfWeek 需为非空 0-6 数字数组（0=周日）');
  }
  const uniq = [...new Set(days as number[])] as ScheduleDay[];
  if (typeof input.startTime !== 'string' || !TIME_RE.test(input.startTime)) {
    throw new AppError('CONFIG_LOAD_FAILED', 'startTime 需为 HH:mm（24h）');
  }
  const endTime = input.endTime as unknown;
  if (endTime !== undefined && endTime !== null && (typeof endTime !== 'string' || !TIME_RE.test(endTime))) {
    throw new AppError('CONFIG_LOAD_FAILED', 'endTime 需为 HH:mm 或 null');
  }
  if (input.timezone !== undefined && typeof input.timezone !== 'string') {
    throw new AppError('CONFIG_LOAD_FAILED', 'timezone 必须为字符串');
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
 * 计算下次执行时间：在 daysOfWeek 中找 startTime 对应的最近未来时刻（本地时区）。
 * 支持跨天窗口（end < start 时次日结束，但触发点仍为 start）。已过期 nextRunAt 会被推进。
 */
export function computeNextRunAt(schedule: { daysOfWeek: ScheduleDay[]; startTime: string; endTime: string | null; timezone: string }, nowMs: number): string | null {
  if (schedule.daysOfWeek.length === 0) return null;
  const [startH, startM] = schedule.startTime.split(':').map(Number) as [number, number];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(nowMs + offset * 24 * 60 * 60 * 1000);
    const dow = candidate.getDay() as ScheduleDay;
    if (!schedule.daysOfWeek.includes(dow)) continue;
    const candidateStart = new Date(candidate);
    candidateStart.setHours(startH, startM, 0, 0);
    if (candidateStart.getTime() > nowMs) return candidateStart.toISOString();
    // 今天已过 start，但仍在跨天窗口内（end < start 且 now 在 start..次日）——该窗口仍在进行，
    // 触发点已过则推至下个匹配日；这里仅在恰好仍在窗口内且曾触发过时，跳到次日再算。
  }
  return null;
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

export type { AppEventBus };