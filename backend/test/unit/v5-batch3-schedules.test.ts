import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { computeNextRunAt, dueSchedules } from '../../src/api/routes/schedules.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
}

describe('V5 Batch3 #125: schedules', () => {
  it('starts today when Saturday 17:00 is still ahead of Saturday 16:50', () => {
    const now = new Date(2026, 9, 3, 16, 50).getTime();
    const schedule = { daysOfWeek: [6] as const, startTime: '17:00', endTime: null, timezone: 'local' };
    const input = { ...schedule, daysOfWeek: [...schedule.daysOfWeek] };
    expect(computeNextRunAt(input, now)).toBe(new Date(2026, 9, 3, 17, 0).toISOString());
    // 达到或超过今天的开始时间后，才轮到下周六。
    for (const minute of [0, 1]) {
      expect(computeNextRunAt(input, new Date(2026, 9, 3, 17, minute).getTime()))
        .toBe(new Date(2026, 9, 10, 17, 0).toISOString());
    }
    expect(computeNextRunAt({ ...input, daysOfWeek: [] }, now)).toBeNull();
  });

  it('keeps Saturday 17:11 on October 3 rather than displaying Sunday October 4', () => {
    const now = new Date(2026, 9, 3, 17, 10).getTime();
    const next = computeNextRunAt({ daysOfWeek: [1, 6], startTime: '17:11', endTime: null, timezone: 'local' }, now);
    expect(next).toBe(new Date(2026, 9, 3, 17, 11).toISOString());
    expect(new Date(next!).getDay()).toBe(6);
  });

  it('uses local time even for legacy explicit or invalid timezones', () => {
    const now = new Date(2026, 9, 3, 16, 50).getTime();
    for (const timezone of ['local', 'UTC', 'America/New_York', 'Bad/Zone']) {
      const next = computeNextRunAt({ daysOfWeek: [6], startTime: '17:00', endTime: '01:00', timezone }, now);
      expect(next).toBe(new Date(2026, 9, 3, 17, 0).toISOString());
    }
  });

  it('handles midnight, calendar rollover and the nearest selected weekday', () => {
    const now = new Date(2026, 11, 31, 23, 50).getTime();
    expect(computeNextRunAt({ daysOfWeek: [4, 5, 6], startTime: '00:00', endTime: null, timezone: 'local' }, now))
      .toBe(new Date(2027, 0, 1, 0, 0).toISOString());
  });

  it('keeps the local start hour across daylight-saving transitions', () => {
    for (const [month, day] of [[2, 7], [9, 31]]) {
      const now = new Date(2026, month!, day!, 23, 50).getTime();
      const expected = new Date(2026, month!, day! + 1, 17, 0);
      expect(computeNextRunAt({ daysOfWeek: [0], startTime: '17:00', endTime: null, timezone: 'local' }, now))
        .toBe(expected.toISOString());
    }
  });

  it('creates, lists and executes today’s plan using local time, and repairs old cached dates', async () => {
    const clock = new FakeClock(new Date(2026, 9, 3, 16, 50).getTime());
    const services = buildServices({ dbPath: ':memory:', clock });
    const { app } = buildApp(services);
    const inj = host(app);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 's' });
    const url = `/api/v1/rooms/${room.id}/schedules`;
    try {
      const create = await inj({ method: 'POST', url, payload: { daysOfWeek: [6], startTime: '17:00', timezone: 'UTC' } });
      expect(create.statusCode).toBe(201);
      const schedule = create.json().schedule;
      const today = new Date(2026, 9, 3, 17, 0).toISOString();
      expect(schedule.timezone).toBe('local');
      expect(schedule.nextRunAt).toBe(today);

      // 旧版误算到下周的缓存，列表读取时也必须校正。
      services.schedules.update(schedule.id, { nextRunAt: new Date(2026, 9, 10, 17, 0).toISOString() });
      const list = (await inj({ method: 'GET', url })).json().schedules;
      expect(list[0].nextRunAt).toBe(today);
      expect(services.schedules.get(schedule.id)!.nextRunAt).toBe(today);

      // 旧版指定时区计划在调度时转换；转换前的过期时间不能导致提前执行。
      services.schedules.update(schedule.id, { timezone: 'America/New_York', nextRunAt: new Date(clock.now() - 60_000).toISOString() });
      expect(dueSchedules(services, clock.now())).toHaveLength(0);
      expect(services.schedules.get(schedule.id)!.timezone).toBe('local');
      expect(services.schedules.get(schedule.id)!.nextRunAt).toBe(today);
      clock.advance(10 * 60_000);
      expect(dueSchedules(services, clock.now())).toHaveLength(1);
      expect(dueSchedules(services, clock.now())).toHaveLength(0);
      expect(services.schedules.get(schedule.id)!.nextRunAt).toBe(new Date(2026, 9, 10, 17, 0).toISOString());

      const disabled = await inj({ method: 'POST', url, payload: { daysOfWeek: [6], startTime: '18:00', enabled: false } });
      expect(disabled.json().schedule.nextRunAt).toBeNull();
      const updated = await inj({ method: 'PATCH', url: `${url}/${schedule.id}`, payload: { startTime: '18:00', timezone: 'UTC' } });
      expect(updated.json().schedule.timezone).toBe('local');
      expect(updated.json().schedule.nextRunAt).toBe(new Date(2026, 9, 3, 18, 0).toISOString());
    } finally {
      await app.close();
    }
  });

  it('schedule CRUD with nextRunAt computation', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const room = (await inj({ method: 'POST', url: '/api/v1/rooms', payload: { platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 's' } })).json().room;

    const create = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1, 3, 5], startTime: '20:00', endTime: '22:00', timezone: 'local' } });
    expect(create.statusCode).toBe(201);
    const schedule = create.json().schedule;
    expect(schedule.id.startsWith('sch_')).toBe(true);
    expect(schedule.daysOfWeek).toEqual([1, 3, 5]);
    expect(schedule.nextRunAt).not.toBeNull();

    const list = (await inj({ method: 'GET', url: `/api/v1/rooms/${room.id}/schedules` })).json();
    expect(list.schedules).toHaveLength(1);

    const patch = await inj({ method: 'PATCH', url: `/api/v1/rooms/${room.id}/schedules/${schedule.id}`, payload: { enabled: false } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().schedule.enabled).toBe(false);
    expect(patch.json().schedule.nextRunAt).toBeNull();

    // 校验非法输入
    const badDays = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [9], startTime: '20:00' } });
    expect(badDays.statusCode).toBe(422);
    const badTime = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1], startTime: '25:99' } });
    expect(badTime.statusCode).toBe(422);
    const badTz = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1], startTime: '20:00', timezone: 'Bad/Zone' } });
    expect(badTz.statusCode).toBe(201);
    expect(badTz.json().schedule.timezone).toBe('local');
    await inj({ method: 'DELETE', url: `/api/v1/rooms/${room.id}/schedules/${badTz.json().schedule.id}` });

    const del = await inj({ method: 'DELETE', url: `/api/v1/rooms/${room.id}/schedules/${schedule.id}` });
    expect(del.statusCode).toBe(204);
    const missing = await inj({ method: 'GET', url: `/api/v1/rooms/${room.id}/schedules` });
    expect(missing.json().schedules).toHaveLength(0);

    // 旧客户端传入时区时，统一标准化为本机时间。
    const okTz = await inj({ method: 'POST', url: `/api/v1/rooms/${room.id}/schedules`, payload: { daysOfWeek: [1], startTime: '20:00', timezone: 'Asia/Shanghai' } });
    expect(okTz.statusCode).toBe(201);
    await app.close();
  });

  it('dueSchedules triggers once and advances nextRunAt', () => {
    const services = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 's' });
    const schedule = services.schedules.create({ roomId: room.id, daysOfWeek: [6], startTime: '10:00', timezone: 'local' });
    // 已到（10:00 < now 11:00 同周六）。
    const now = new Date('2026-08-29T11:00:00.000Z').getTime();
    services.schedules.update(schedule.id, { nextRunAt: new Date('2026-08-29T10:00:00.000Z').toISOString() });
    const due1 = dueSchedules(services, now);
    expect(due1.length).toBe(1);
    expect(due1[0]!.roomId).toBe(room.id);
    // 已推进 → 再次调用不重复触发。
    const due2 = dueSchedules(services, now);
    expect(due2.length).toBe(0);
    expect(services.schedules.get(schedule.id)!.nextRunAt).not.toBeNull();
  });
});