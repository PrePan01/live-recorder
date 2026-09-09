import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';

describe('recording HTTP range playback', () => {
  it('supports single, open-ended and suffix ranges while retaining full reads', async () => {
    const services = buildServices({ dbPath: ':memory:' });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: 'range' });
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lr-range-')), 'recording.flv');
    const data = Buffer.concat([Buffer.from('FLV'), Buffer.from('0123456789')]);
    await writeFile(file, data);
    const recording = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: null, streamTitle: '' });
    services.recordings.update(recording.id, { state: 'completed', filePath: file });
    const { app } = buildApp(services);
    const base = { method: 'GET' as const, url: `/api/v1/recordings/${recording.id}/file`, headers: { host: '127.0.0.1:43120' } };
    const full = await app.inject(base);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-length']).toBe(String(data.length));
    const partial = await app.inject({ ...base, headers: { ...base.headers, range: 'bytes=3-5' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 3-5/${data.length}`);
    expect(partial.rawPayload.toString()).toBe('012');
    const suffix = await app.inject({ ...base, headers: { ...base.headers, range: 'bytes=-2' } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.toString()).toBe('89');
    const invalid = await app.inject({ ...base, headers: { ...base.headers, range: 'bytes=999-' } });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe(`bytes */${data.length}`);
    const multiple = await app.inject({ ...base, headers: { ...base.headers, range: 'bytes=0-1,3-4' } });
    expect(multiple.statusCode).toBe(200);
    expect(multiple.rawPayload).toEqual(data);
    await app.close();
  });
});
