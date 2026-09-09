import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';

const HOST = { host: '127.0.0.1:43120' };

describe('room insight batch endpoint', () => {
  it('returns one aggregate result per requested room without per-card APIs', async () => {
    const clock = new FakeClock(new Date('2026-08-28T12:00:00Z').getTime());
    const services = buildServices({ dbPath: ':memory:', clock });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/101', displayName: 'A' });
    for (let day = 1; day <= 3; day += 1) {
      const rec = services.recordings.create({ roomId: room.id, roomName: 'A', platform: 'bilibili', streamSessionId: `s${day}`, streamTitle: '' });
      const startedAt = new Date(clock.now() - day * 86_400_000).toISOString();
      const endedAt = new Date(clock.now() - day * 86_400_000 + 3_600_000).toISOString();
      services.recordings.update(rec.id, { state: day === 3 ? 'failed' : 'completed', startedAt, endedAt, fileSizeBytes: day * 100 });
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
});
