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
it('computeNextRunAt finds next matching weekday start', () => {
  const now = new Date('2026-08-29T10:00:00.000Z').getTime();
  const nowDow = new Date(now).getDay();
  // 若今天不在 daysOfWeek，必然推进到未来某匹配日。
  const next = computeNextRunAt({ daysOfWeek: [nowDow], startTime: '12:00', endTime: null, timezone: 'local' }, now);
  expect(next).not.toBeNull();
  const nextDate = new Date(next!).getTime();
  expect(nextDate).toBeGreaterThan(now);
  expect(new Date(next!).getDay()).toBe(nowDow);

  // 已过今天 start → 推到下个匹配日（同日已不可能，>7 天内仍有匹配日）。
  const past = computeNextRunAt({ daysOfWeek: [nowDow], startTime: '09:00', endTime: null, timezone: 'local' }, now);
  expect(past).not.toBeNull();
  expect(new Date(past!).getDay()).toBe(nowDow);
  // 无匹配日 → null。
  const none = computeNextRunAt({ daysOfWeek: [] as never[], startTime: '12:00', endTime: null, timezone: 'local' }, now);
  expect(none).toBeNull();
});

it('honors timezone when computing nextRunAt (#135)', () => {
  // 基准：2026-08-29 00:00 UTC = 北京 08:00（UTC+8）。
  const now = new Date('2026-08-29T00:00:00.000Z').getTime();
  // Asia/Shanghai 时区下今天 08:00 已过，09:00 未到 → 今天 09:00 CST = 01:00 UTC。
  const next = computeNextRunAt({ daysOfWeek: [6], startTime: '09:00', endTime: null, timezone: 'Asia/Shanghai' }, now);
  expect(next).toBe('2026-08-29T01:00:00.000Z');
  // UTC 时区下今天 09:00 未到 → 09:00 UTC。
  const nextUtc = computeNextRunAt({ daysOfWeek: [6], startTime: '09:00', endTime: null, timezone: 'UTC' }, now);
  expect(nextUtc).toBe('2026-08-29T09:00:00.000Z');
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
    expect(badTz.statusCode).toBe(422);

    const del = await inj({ method: 'DELETE', url: `/api/v1/rooms/${room.id}/schedules/${schedule.id}` });
    expect(del.statusCode).toBe(204);
    const missing = await inj({ method: 'GET', url: `/api/v1/rooms/${room.id}/schedules` });
    expect(missing.json().schedules).toHaveLength(0);

    // 有效 IANA 时区可创建（校验通过）
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