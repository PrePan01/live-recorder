import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';

const HOST = { host: '127.0.0.1:43120' };

describe('room insight batch endpoint', () => {
  it.each([[false, false], [true, false], [false, true]])('records the live observation after authorization recovery (history=%s, recording=%s)', async (withHistory, recording) => {
    const clock = new FakeClock(Date.parse('2026-10-07T12:00:00Z'));
    const services = buildServices({ dbPath: ':memory:', clock, mode: 'fake' });
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/104', displayName: 'Recovered' });
    if (withHistory) services.liveEvents.record(room.id, '2026-10-01T00:00:00.000Z');
    if (recording) vi.spyOn(services.manager, 'isRoomActive').mockReturnValue(true);
    const adapter = services.adapterFor('douyin') as FakePlatformAdapter;
    adapter.setScript([{ status: 'restricted' }, { status: 'live', streamSessionId: 'recovered' }]);
    const { app } = buildApp(services);
    try {
      await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
      // Prime the insights cache before recovery, then verify SSE invalidation.
      await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id] } });
      await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
      const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id] } });
      expect(response.json().insights[room.id].sorting.lastLiveAt).toBe(clock.iso());
      const events = services.liveEvents.list(room.id, '2026-10-07T00:00:00Z');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ source: 'initial_live', lowerBoundAt: null });
      clock.advance(60_000);
      await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
      expect(services.liveEvents.list(room.id, '2026-10-07T00:00:00Z')).toHaveLength(1);
    } finally {
      await app.close();
      services.db.close();
    }
  });

  it('keeps the original start when authorization recovers during a known live cycle', async () => {
    const clock = new FakeClock(Date.parse('2026-10-07T12:00:00Z'));
    const services = buildServices({ dbPath: ':memory:', clock, mode: 'fake' });
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/105', displayName: 'Same cycle' });
    const startedAt = '2026-10-07T10:00:00.000Z';
    services.rooms.setLiveStatus(room.id, 'live', startedAt);
    services.liveEvents.record(room.id, startedAt);
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([{ status: 'restricted' }, { status: 'live' }]);
    const { app } = buildApp(services);
    try {
      await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
      await services.scheduler.checkRoom(services.rooms.get(room.id)!, { nameOnly: true });
      const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id] } });
      expect(response.json().insights[room.id].sorting.lastLiveAt).toBe(startedAt);
      expect(services.liveEvents.list(room.id, '2026-10-07T00:00:00Z')).toHaveLength(1);
    } finally {
      await app.close();
      services.db.close();
    }
  });

  it('uses persisted cycle time for missing legacy observations while preserving platform start times', async () => {
    const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/106', displayName: 'Legacy' });
    const known = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/107', displayName: 'Platform' });
    const detectedAt = '2026-10-07T12:00:00.000Z';
    const platformStartedAt = '2026-10-07T10:00:00.000Z';
    services.rooms.setLiveStatus(room.id, 'live', detectedAt);
    services.liveEvents.record(room.id, '2026-10-01T00:00:00.000Z');
    services.rooms.setLiveStatus(known.id, 'live', detectedAt);
    services.liveEvents.record(known.id, detectedAt, { source: 'platform', platformStartedAt });
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id, known.id] } });
      expect(response.json().insights[room.id].sorting.lastLiveAt).toBe(detectedAt);
      expect(response.json().insights[known.id].sorting.lastLiveAt).toBe(platformStartedAt);
    } finally {
      await app.close();
      services.db.close();
    }
  });

  it('returns one aggregate result per requested room without per-card APIs', async () => {
    const clock = new FakeClock(new Date('2026-08-28T12:00:00Z').getTime());
    const services = buildServices({ dbPath: ':memory:', clock });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/101', displayName: 'A' });
    for (let day = 1; day <= 3; day += 1) {
      const rec = services.recordings.create({ roomId: room.id, roomName: 'A', platform: 'bilibili', streamSessionId: `s${day}`, streamTitle: '' });
      const startedAt = new Date(clock.now() - day * 86_400_000).toISOString();
      const endedAt = new Date(clock.now() - day * 86_400_000 + 3_600_000).toISOString();
      services.recordings.update(rec.id, { state: day === 3 ? 'failed' : 'completed', startedAt, endedAt, fileSizeBytes: day * 100 });
      services.liveEvents.record(room.id, startedAt);
    }
    const { app } = buildApp(services);
    const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id] } });
    expect(response.statusCode).toBe(200);
    const insight = response.json().insights[room.id];
    expect(insight.totalRecordings).toBe(3);
    expect(insight.totalBytes).toBe(600);
    expect(insight.completed).toBe(2);
    expect(insight.failed).toBe(1);
    expect(insight.prediction.basedOnDays).toBe(3);
    expect(insight.prediction.startAt).toBeTruthy();
    await app.close();
  });

  it('limits a batch to 100 IDs', async () => {
    const services = buildServices({ dbPath: ':memory:' });
    const { app } = buildApp(services);
    const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: Array.from({ length: 101 }, (_, i) => `room-${i}`) } });
    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it('returns lifetime sorting metrics independently of the seven-day statistics', async () => {
    const clock = new FakeClock(Date.parse('2026-10-07T12:00:00Z'));
    const services = buildServices({ dbPath: ':memory:', clock });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/102', displayName: 'History' });
    const empty = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/103', displayName: 'Empty' });
    for (const [startedAt, endedAt] of [
      ['2026-01-01T00:00:00Z', '2026-01-01T04:00:00Z'],
      ['2026-10-06T00:00:00Z', '2026-10-06T01:00:00Z'],
    ]) {
      const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: startedAt, streamTitle: '' });
      services.recordings.update(rec.id, { startedAt, endedAt, state: 'completed' });
    }
    services.liveEvents.record(room.id, '2026-01-01T03:00:00Z', { source: 'platform', platformStartedAt: '2026-01-01T00:00:00Z' });
    const { app } = buildApp(services);
    const response = await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: HOST, payload: { roomIds: [room.id, empty.id] } });
    expect(response.statusCode).toBe(200);
    const insights = response.json().insights;
    expect(insights[room.id].totalRecordings).toBe(1);
    expect(insights[room.id].sorting).toEqual({ lastRecordedAt: '2026-10-06T00:00:00Z', lastLiveAt: '2026-01-01T00:00:00Z', totalDurationMs: 18_000_000, totalRecordings: 2 });
    expect(insights[empty.id].sorting).toEqual({ lastRecordedAt: null, lastLiveAt: null, totalDurationMs: 0, totalRecordings: 0 });
    await app.close();
  });
});
