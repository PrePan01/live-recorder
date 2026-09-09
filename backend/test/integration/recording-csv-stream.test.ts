import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';

describe('full CSV recording export', () => {
  it('streams every matching record beyond the former 100-row cap in stable order', async () => {
    const services = buildServices({ dbPath: ':memory:' });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/987', displayName: 'csv' });
    for (let i = 0; i < 105; i += 1) {
      const record = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: `s${i}`, streamTitle: `title ${i}` });
      const startedAt = new Date(Date.UTC(2026, 7, 28, 0, 0, 0, i)).toISOString();
      services.recordings.update(record.id, { state: 'completed', startedAt, endedAt: new Date(Date.parse(startedAt) + 1_000).toISOString() });
    }
    const { app } = buildApp(services);
    const response = await app.inject({ method: 'GET', url: `/api/v1/recordings/export?roomId=${room.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(response.statusCode).toBe(200);
    expect(response.body.startsWith('\uFEFFid,roomId')).toBe(true);
    expect(response.body).toContain('totalRecordings,105');
    const lines = response.body.trim().split('\r\n');
    const data = lines.slice(1, -2);
    expect(data).toHaveLength(105);
    const timestamps = data.map((line) => line.split(',')[5]!);
    expect(timestamps).toEqual([...timestamps].sort().reverse());
    await app.close();
  });
});
