import { describe, expect, it, vi } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
const iso = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
function setup(now = '2026-09-15T08:00:00') {
  const clock = new FakeClock(new Date(now).getTime()),
    services = buildServices({ dbPath: ':memory:', clock });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/901', displayName: '预测测试' });
  return { clock, services, room };
}
async function finalize(services: ReturnType<typeof setup>['services']) {
  await (services.scheduler as unknown as { finalizePastPredictions(): Promise<void> }).finalizePastPredictions();
}
function seedCoverage(services: ReturnType<typeof setup>['services'], roomId: string, startAt: string, endAt: string) {
  services.db.prepare('INSERT INTO prediction_coverage_intervals (room_id,start_at,end_at) VALUES (?,?,?)').run(roomId, startAt, endAt);
}
describe('prediction calibration regressions', () => {
  it('records separate calibration rows for two predicted sessions on one date', () => {
    const { services, clock, room } = setup('2026-09-15T17:00:00');
    for (const day of ['2026-09-01', '2026-09-08']) {
      for (const time of ['18:00', '20:00'])
        services.liveEvents.record(room.id, iso(day, time), { source: 'platform', platformStartedAt: iso(day, time) });
      seedCoverage(services, room.id, iso(day, '17:45'), iso(day, '20:15'));
    }
    const record = () => (services.scheduler as unknown as { recordTodayForecast(roomId: string): void }).recordTodayForecast(room.id);
    record();
    services.liveEvents.record(room.id, iso('2026-09-15', '18:00'), { source: 'platform', platformStartedAt: iso('2026-09-15', '18:00') });
    clock.advance(2 * 60 * 60_000);
    record();
    const forecasts = services.predictionCalibration.pendingBefore('2026-09-16');
    expect(forecasts.map((forecast) => forecast.windowStartAt).sort()).toEqual([
      iso('2026-09-15', '17:45'),
      iso('2026-09-15', '19:45'),
    ]);
    services.db.close();
  });
  it('records a forecast with two independent dates and retries after an earlier insufficient check', async () => {
    const { services, clock, room } = setup('2026-09-14T08:00:00');
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    adapter.checkLiveStatus = async () => ({ status: 'offline' });
    function history(day: string) {
      services.liveEvents.record(room.id, iso(day, '20:00'), { source: 'platform', platformStartedAt: iso(day, '20:00') });
      seedCoverage(services, room.id, iso(day, '19:00'), iso(day, '21:00'));
    }
    history('2026-08-31');
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.predictionCalibration.pendingBefore('2026-09-15')).toHaveLength(0);
    history('2026-09-07');
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    const pending = services.predictionCalibration.pendingBefore('2026-09-15');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      rawProbability: 'high',
      probability: 'low',
      windowStartAt: iso('2026-09-14', '19:45'),
      windowEndAt: iso('2026-09-14', '20:15'),
    });
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.predictionCalibration.pendingBefore('2026-09-15')).toHaveLength(1);
    services.db.close();
  });
  it('does not use morning coverage to call an unmonitored evening a miss', async () => {
    const { services, room } = setup();
    services.predictionCalibration.recordForecast({
      roomId: room.id,
      targetDate: '2026-09-14',
      probability: 'low',
      rawProbability: 'high',
      generatedAt: iso('2026-09-14', '08:00'),
      windowStartAt: iso('2026-09-14', '20:00'),
      windowEndAt: iso('2026-09-14', '20:30'),
    });
    for (const time of ['08:00', '10:00', '14:00'])
      services.predictionCalibration.recordCoverage(room.id, '2026-09-14', iso('2026-09-14', time));
    await finalize(services);
    expect(services.db.prepare('SELECT outcome FROM prediction_forecasts').get()).toEqual({ outcome: 'unknown' });
    services.db.close();
  });
  it('settles a fully monitored empty window as a miss in its raw bucket', async () => {
    const { services, room } = setup();
    services.predictionCalibration.recordForecast({
      roomId: room.id,
      targetDate: '2026-09-14',
      probability: 'low',
      rawProbability: 'high',
      generatedAt: iso('2026-09-14', '08:00'),
      windowStartAt: iso('2026-09-14', '20:00'),
      windowEndAt: iso('2026-09-14', '20:30'),
    });
    seedCoverage(services, room.id, iso('2026-09-14', '19:00'), iso('2026-09-14', '21:00'));
    await finalize(services);
    expect(services.predictionCalibration.profiles([room.id], '2026-09-01').get(room.id)).toEqual({ high: { hits: 0, total: 1 } });
    services.db.close();
  });
  it('waits for a midnight window to finish and uses the actual platform start date', async () => {
    const { services, clock, room } = setup('2026-09-15T00:05:00');
    services.predictionCalibration.recordForecast({
      roomId: room.id,
      targetDate: '2026-09-14',
      probability: 'medium',
      rawProbability: 'high',
      generatedAt: iso('2026-09-14', '08:00'),
      windowStartAt: iso('2026-09-14', '23:50'),
      windowEndAt: iso('2026-09-15', '00:20'),
    });
    services.liveEvents.record(room.id, iso('2026-09-15', '00:05'), { source: 'platform', platformStartedAt: iso('2026-09-14', '23:55') });
    await finalize(services);
    expect(services.predictionCalibration.pendingBefore('2026-09-15')).toHaveLength(1);
    clock.advance(60 * 60_000);
    await finalize(services);
    expect(services.predictionCalibration.profiles([room.id], '2026-09-01').get(room.id)).toEqual({ high: { hits: 1, total: 1 } });
    services.db.close();
  });
  it('excludes legacy calibration rows that cannot identify the forecast window or raw bucket', async () => {
    const { services, room } = setup();
    services.predictionCalibration.recordForecast({
      roomId: room.id,
      targetDate: '2026-09-14',
      probability: 'high',
      generatedAt: iso('2026-09-14', '08:00'),
    });
    await finalize(services);
    expect(services.predictionCalibration.profiles([room.id], '2026-09-01').size).toBe(0);
    expect(services.db.prepare('SELECT outcome FROM prediction_forecasts').get()).toEqual({ outcome: 'unknown' });
    services.db.close();
  });
  it('merges consecutive polling checks but preserves long shutdown gaps', () => {
    const { services, room } = setup();
    for (const time of ['23:49', '23:51', '23:53'])
      services.predictionCalibration.recordCoverage(room.id, '2026-09-14', iso('2026-09-14', time));
    for (const time of ['00:10', '00:12', '00:14'])
      services.predictionCalibration.recordCoverage(room.id, '2026-09-15', iso('2026-09-15', time));
    const intervals = services.predictionCalibration.intervals([room.id], iso('2026-09-14', '00:00')).get(room.id)!;
    expect(intervals).toEqual([
      { startAt: iso('2026-09-14', '23:49'), endAt: iso('2026-09-14', '23:53') },
      { startAt: iso('2026-09-15', '00:10'), endAt: iso('2026-09-15', '00:14') },
    ]);
    services.db.close();
  });
  it('throttles unchanged insufficient history but keeps monitoring coverage and refreshes on new events', async () => {
    const { services, clock, room } = setup();
    (services.adapterFor('bilibili') as FakePlatformAdapter).checkLiveStatus = async () => ({ status: 'offline' });
    for (const day of ['2026-09-01', '2026-09-08'])
      services.liveEvents.record(room.id, iso(day, '20:00'), { source: 'platform', platformStartedAt: iso(day, '20:00') });
    const read = vi.spyOn(services.liveEvents, 'list');
    for (let i = 0; i < 5; i++) {
      await services.scheduler.triggerImmediateCheck(room.id);
      clock.advance(60_000);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(services.predictionCalibration.coverage(room.id, '2026-09-15')?.checks).toBe(5);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(read).toHaveBeenCalledTimes(2);
    services.liveEvents.record(room.id, iso('2026-09-14', '20:00'), { source: 'platform', platformStartedAt: iso('2026-09-14', '20:00') });
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(read).toHaveBeenCalledTimes(3);
    services.db.close();
  });
  it('refreshes an insufficient forecast at midnight before its throttle expires', async () => {
    const { services, clock, room } = setup('2026-09-14T23:59:00');
    (services.adapterFor('bilibili') as FakePlatformAdapter).checkLiveStatus = async () => ({ status: 'offline' });
    const read = vi.spyOn(services.liveEvents, 'list');
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(read).toHaveBeenCalledTimes(2);
    services.db.close();
  });
  it('refreshes when a prediction window ends before the normal retry interval', async () => {
    const { services, clock, room } = setup('2026-09-15T20:13:00');
    (services.adapterFor('bilibili') as FakePlatformAdapter).checkLiveStatus = async () => ({ status: 'offline' });
    for (const day of ['2026-09-01', '2026-09-08'])
      services.liveEvents.record(room.id, iso(day, '20:00'), { source: 'platform', platformStartedAt: iso(day, '20:00') });
    const read = vi.spyOn(services.liveEvents, 'list');
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(3 * 60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(read).toHaveBeenCalledTimes(2);
    services.db.close();
  });
});
