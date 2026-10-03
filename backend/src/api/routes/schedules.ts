import type { FastifyInstance } from "fastify";
import { AppError } from "../../types/error.js";
import type { Services } from "../../core/services.js";
import type { RecordingSchedule, ScheduleDay } from "../../types/index.js";
import { AppEventBus } from "../../core/events.js";

const DAYS: ScheduleDay[] = [0, 1, 2, 3, 4, 5, 6];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 校验并标准化计划输入。 */
function validateSchedule(input: {
  daysOfWeek?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  timezone?: unknown;
  enabled?: unknown;
}): {
  daysOfWeek: ScheduleDay[];
  startTime: string;
  endTime: string | null;
  timezone: string;
  enabled: boolean;
} {
  const days = input.daysOfWeek as unknown;
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.some((d) => typeof d !== "number" || !DAYS.includes(d as ScheduleDay))
  ) {
    throw new AppError(
      "CONFIG_INVALID",
      "daysOfWeek 需为非空 0-6 数字数组（0=周日）",
    );
  }
  const uniq = [...new Set(days as number[])] as ScheduleDay[];
  if (typeof input.startTime !== "string" || !TIME_RE.test(input.startTime)) {
    throw new AppError("CONFIG_INVALID", "startTime 需为 HH:mm（24h）");
  }
  const endTime = input.endTime as unknown;
  if (
    endTime !== undefined &&
    endTime !== null &&
    (typeof endTime !== "string" || !TIME_RE.test(endTime))
  ) {
    throw new AppError("CONFIG_INVALID", "endTime 需为 HH:mm 或 null");
  }
  return {
    daysOfWeek: uniq,
    startTime: input.startTime,
    endTime:
      endTime === undefined || endTime === null ? null : (endTime as string),
    timezone: "local",
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

/** 找到本机日历中最近的未来开始时间，包含今天尚未到达的开始时间。 */
export function computeNextRunAt(
  schedule: {
    daysOfWeek: ScheduleDay[];
    startTime: string;
    endTime: string | null;
    timezone: string;
  },
  nowMs: number,
): string | null {
  const now = new Date(nowMs);
  const [startH, startM] = schedule.startTime.split(":").map(Number) as [
    number,
    number,
  ];
  for (let offset = 0; offset <= 7; offset += 1) {
    // 按日历递增日期，而不是累加 24 小时，保证夏令时切换时仍遵循本机时间。
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + offset,
      startH,
      startM,
    );
    if (!schedule.daysOfWeek.includes(candidate.getDay() as ScheduleDay))
      continue;
    if (candidate.getTime() > nowMs) return candidate.toISOString();
  }
  return null;
}

/** 校正旧时区和未来缓存；保留本机计划已到期的触发点，供重启后补执行。 */
function synchronizeSchedule(
  services: Services,
  schedule: RecordingSchedule,
  nowMs: number,
): RecordingSchedule {
  const pending =
    schedule.nextRunAt && new Date(schedule.nextRunAt).getTime() <= nowMs;
  const nextRunAt = !schedule.enabled
    ? null
    : schedule.timezone === "local" && pending
      ? schedule.nextRunAt
      : computeNextRunAt(schedule, nowMs);
  if (schedule.timezone === "local" && schedule.nextRunAt === nextRunAt)
    return schedule;
  return services.schedules.update(schedule.id, {
    timezone: "local",
    nextRunAt,
  });
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  // 列表：房间所有计划。
  app.get("/api/v1/rooms/:id/schedules", async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room)
      throw new AppError("RESOURCE_NOT_FOUND", "房间不存在", {
        roomId: id,
        details: { resource: "room" },
      });
    const now = services.clock.now();
    const schedules = services.schedules
      .listForRoom(id)
      .map((schedule) => synchronizeSchedule(services, schedule, now));
    return reply.send({ schedules });
  });

  app.post("/api/v1/rooms/:id/schedules", async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room)
      throw new AppError("RESOURCE_NOT_FOUND", "房间不存在", {
        roomId: id,
        details: { resource: "room" },
      });
    const input = validateSchedule((req.body ?? {}) as Record<string, unknown>);
    const schedule = services.schedules.create({ roomId: id, ...input });
    const next = input.enabled
      ? computeNextRunAt(schedule, services.clock.now())
      : null;
    const updated = services.schedules.update(schedule.id, { nextRunAt: next });
    services.events.emit({ type: "schedule:updated", data: updated });
    return reply.status(201).send({ schedule: updated });
  });

  app.patch("/api/v1/rooms/:id/schedules/:scheduleId", async (req, reply) => {
    const { id, scheduleId } = req.params as { id: string; scheduleId: string };
    if (!services.rooms.get(id))
      throw new AppError("RESOURCE_NOT_FOUND", "房间不存在", {
        roomId: id,
        details: { resource: "room" },
      });
    const existing = services.schedules.get(scheduleId);
    if (!existing || existing.roomId !== id)
      throw new AppError("RESOURCE_NOT_FOUND", "计划不存在", {
        details: { resource: "schedule" },
      });
    const input = validateSchedule({ ...existing, ...(req.body ?? {}) });
    let schedule = services.schedules.update(scheduleId, { ...input });
    // enabled 变化时重算 nextRunAt。
    const next = computeNextRunAt(schedule, services.clock.now());
    schedule = services.schedules.update(scheduleId, {
      nextRunAt: input.enabled ? next : null,
    });
    services.events.emit({ type: "schedule:updated", data: schedule });
    return reply.send({ schedule });
  });

  app.delete("/api/v1/rooms/:id/schedules/:scheduleId", async (req, reply) => {
    const { id, scheduleId } = req.params as { id: string; scheduleId: string };
    const existing = services.schedules.get(scheduleId);
    if (!existing || existing.roomId !== id)
      throw new AppError("RESOURCE_NOT_FOUND", "计划不存在", {
        details: { resource: "schedule" },
      });
    services.schedules.remove(scheduleId);
    services.events.emit({
      type: "schedule:updated",
      data: { ...existing, enabled: false },
    });
    return reply.status(204).send();
  });
}

/** 供 Scheduler 集成：到期计划触发一次检测（离线不建立空录制——交给现有 checkRoom 语义）。 */
export function dueSchedules(
  services: Services,
  nowMs: number,
): Array<{ schedule: RecordingSchedule; roomId: string }> {
  const results: Array<{ schedule: RecordingSchedule; roomId: string }> = [];
  for (const stored of services.schedules.listEnabled()) {
    const schedule = synchronizeSchedule(services, stored, nowMs);
    // 已到/已过 nextRunAt → 触发一次（保留重启补执行行为）。
    if (schedule.nextRunAt && new Date(schedule.nextRunAt).getTime() <= nowMs) {
      results.push({ schedule, roomId: schedule.roomId });
      // 推进到下次。
      const recomputed = computeNextRunAt(schedule, nowMs);
      services.schedules.update(schedule.id, { nextRunAt: recomputed });
    }
  }
  return results;
}

export type { AppEventBus };
