import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

const HOST = { host: '127.0.0.1:43120' };
/** 固定“现在”，预测结果才能逐字比对。 */
const NOW = new Date('2026-09-17T20:00:00.000Z').getTime();
const ROOM = { platform: 'bilibili', url: 'https://live.bilibili.com/123' } as const;

function newApp() {
  const services = buildServices({ dbPath: ':memory:', clock: new FakeClock(NOW) });
  const { app } = buildApp(services);
  return { services, app };
}

/** 两周内多次开播 + 检测覆盖 + 历史预测结果，构成一份非平凡样本。 */
function seed(services: Services, roomId: string): void {
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: tmpdir() });
  let checks = 0;
  for (const [day, minute] of [
    ['2026-09-08', 0],
    ['2026-09-09', 5],
    ['2026-09-10', 50],
    ['2026-09-15', 10],
    ['2026-09-16', 25],
  ] as const) {
    services.liveEvents.record(roomId, `${day}T12:${String(minute).padStart(2, '0')}:00.000Z`, {
      source: 'transition',
      lowerBoundAt: `${day}T11:58:00.000Z`,
    });
    services.predictionCalibration.recordCoverage(roomId, day, `${day}T12:00:00.000Z`, 600_000);
    checks += 1;
  }
  // 覆盖区间：连续盯着的一整天 + 之后另一段，用来验证覆盖证据能被完整搬运。
  services.db
    .prepare('INSERT INTO prediction_coverage_intervals (room_id, start_at, end_at) VALUES (?, ?, ?)')
    .run(roomId, '2026-09-08T00:00:00.000Z', '2026-09-17T12:00:00.000Z');
  services.db
    .prepare('INSERT INTO prediction_coverage_intervals (room_id, start_at, end_at) VALUES (?, ?, ?)')
    .run(roomId, '2026-09-17T13:00:00.000Z', '2026-09-17T19:00:00.000Z');
  services.db
    .prepare('INSERT INTO prediction_coverage (room_id, target_date, first_checked_at, last_checked_at, checks) VALUES (?, ?, ?, ?, ?)')
    .run(roomId, '2026-09-07', '2026-09-07T00:30:00.000Z', '2026-09-07T23:30:00.000Z', checks + 40);
  // 录制起点同样是预测的输入（弱证据）。录了两场，验证它不需要录制历史也能还原。
  for (const [id, day, session] of [
    ['rec-1', '2026-09-11', 'sess-1'],
    ['rec-2', '2026-09-12', 'sess-2'],
  ] as const) {
    services.db
      .prepare("INSERT INTO recordings (id, room_id, platform, started_at, state, stream_session_id) VALUES (?, ?, 'bilibili', ?, 'completed', ?)")
      .run(id, roomId, `${day}T12:00:00.000Z`, session);
  }
  services.predictionCalibration.recordForecast({
    roomId,
    targetDate: '2026-09-15',
    probability: 'high',
    generatedAt: '2026-09-15T08:00:00.000Z',
    rawProbability: 'high',
    windowStartAt: '2026-09-15T11:00:00.000Z',
    windowEndAt: '2026-09-15T13:00:00.000Z',
  });
  services.predictionCalibration.recordForecast({
    roomId,
    targetDate: '2026-09-16',
    probability: 'low',
    generatedAt: '2026-09-16T08:00:00.000Z',
    rawProbability: 'medium',
    windowStartAt: '2026-09-16T11:00:00.000Z',
    windowEndAt: '2026-09-16T13:00:00.000Z',
  });
  const [first] = services.predictionCalibration.pendingBefore('2026-09-15');
  if (first) services.predictionCalibration.resolve(first.id, 'hit', '2026-09-15T14:00:00.000Z');
}

async function insight(app: ReturnType<typeof buildApp>['app'], roomId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/rooms/insights/batch',
    headers: HOST,
    payload: { roomIds: [roomId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().insights[roomId].prediction;
}

async function exportConfig(app: ReturnType<typeof buildApp>['app']) {
  const res = await app.inject({ method: 'GET', url: '/api/v1/config/export', headers: HOST });
  expect(res.statusCode).toBe(200);
  return res.json().config;
}

async function importConfig(app: ReturnType<typeof buildApp>['app'], config: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST, payload: { config } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const tableCounts = (services: Services) => ({
  events: (services.db.prepare('SELECT COUNT(*) AS c FROM live_events').get() as { c: number }).c,
  forecasts: (services.db.prepare('SELECT COUNT(*) AS c FROM prediction_forecasts').get() as { c: number }).c,
  coverage: (services.db.prepare('SELECT COUNT(*) AS c FROM prediction_coverage').get() as { c: number }).c,
  intervals: (services.db.prepare('SELECT COUNT(*) AS c FROM prediction_coverage_intervals').get() as { c: number }).c,
  recordingSessions: (services.db.prepare('SELECT COUNT(*) AS c FROM prediction_recording_sessions').get() as { c: number }).c,
});

describe('开播预测数据随配置导出/导入', () => {
  it('搬运到全新安装后预测逐字一致（房间重建、ID 变化）', async () => {
    const source = newApp();
    const sourceRoom = source.services.rooms.create({ ...ROOM, displayName: 'A' });
    seed(source.services, sourceRoom.id);
    const before = await insight(source.app, sourceRoom.id);
    // 样本确实生效了，否则这条用例可能只是“两边都算不出来”。
    expect(before.kind).not.toBe('unavailable');
    expect(before.sampleCount).toBeGreaterThan(0);

    const target = newApp();
    const imported = await importConfig(target.app, await exportConfig(source.app));
    expect(imported.prediction).toEqual({ matchedRooms: 1, skippedRooms: 0, events: 5, forecasts: 2, coverage: 6, intervals: 7, recordingSessions: 2 });

    const targetRoom = target.services.rooms.list()[0]!;
    expect(targetRoom.id).not.toBe(sourceRoom.id);
    const after = await insight(target.app, targetRoom.id);
    expect({ ...after, roomId: 'ignored' }).toEqual({ ...before, roomId: 'ignored' });

    await source.app.close();
    await target.app.close();
  });

  it('重复导入同一份文件不会翻倍或改变预测', async () => {
    const source = newApp();
    const sourceRoom = source.services.rooms.create({ ...ROOM, displayName: 'A' });
    seed(source.services, sourceRoom.id);
    const config = await exportConfig(source.app);

    const target = newApp();
    const first = await importConfig(target.app, config);
    const counts = tableCounts(target.services);
    const second = await importConfig(target.app, config);

    expect(second.prediction).toEqual({
      matchedRooms: 1,
      skippedRooms: 0,
      events: 0,
      forecasts: 0,
      coverage: first.prediction.coverage,
      intervals: 0,
      recordingSessions: 0,
    });
    expect(tableCounts(target.services)).toEqual(counts);
    const roomId = target.services.rooms.list()[0]!.id;
    expect({ ...(await insight(target.app, roomId)), roomId: 'ignored' }).toEqual({
      ...(await insight(source.app, sourceRoom.id)),
      roomId: 'ignored',
    });

    await source.app.close();
    await target.app.close();
  });

  it('直播间未匹配时跳过预测数据且不影响导入其它内容', async () => {
    const source = newApp();
    const sourceRoom = source.services.rooms.create({ ...ROOM, displayName: 'A' });
    seed(source.services, sourceRoom.id);
    const config = await exportConfig(source.app);

    const target = newApp();
    const imported = await importConfig(target.app, { ...config, rooms: [] });
    expect(imported.prediction).toEqual({ matchedRooms: 0, skippedRooms: 1, events: 0, forecasts: 0, coverage: 0, intervals: 0, recordingSessions: 0 });
    expect(imported.importedRooms).toBe(0);
    expect(tableCounts(target.services)).toEqual({ events: 0, forecasts: 0, coverage: 0, intervals: 0, recordingSessions: 0 });

    await source.app.close();
    await target.app.close();
  });

  it('同一房间同一毫秒的两条开播记录原样保留（手动检测与定时检测撞车）', async () => {
    const source = newApp();
    const room = source.services.rooms.create({ ...ROOM, displayName: 'A' });
    source.services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: tmpdir() });
    source.services.liveEvents.record(room.id, '2026-09-10T12:00:00.000Z', { source: 'transition', lowerBoundAt: '2026-09-10T11:59:00.000Z' });
    source.services.liveEvents.record(room.id, '2026-09-10T12:00:00.000Z', { source: 'platform', platformStartedAt: '2026-09-10T11:59:30.000Z' });
    expect(tableCounts(source.services).events).toBe(2);

    const target = newApp();
    await importConfig(target.app, await exportConfig(source.app));
    expect(tableCounts(target.services).events).toBe(2);
    await importConfig(target.app, await exportConfig(source.app));
    expect(tableCounts(target.services).events).toBe(2);

    await source.app.close();
    await target.app.close();
  });

  it('旧文件没有预测数据时导入照常完成', async () => {
    const source = newApp();
    source.services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: tmpdir() });
    source.services.rooms.create({ ...ROOM, displayName: 'A' });
    const { prediction: _omitted, ...legacy } = await exportConfig(source.app);

    const target = newApp();
    const imported = await importConfig(target.app, legacy);
    expect(imported.prediction).toBeNull();
    expect(imported.importedRooms).toBe(1);

    await source.app.close();
    await target.app.close();
  });
});
