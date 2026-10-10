import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { buildApp } from '../../src/api/server.js';
import { DanmakuStore } from '../../src/danmaku/store.js';
const headers = { host: '127.0.0.1:43120' };

it('exports both formats from completed history and rejects invalid export requests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-export-api-'));
  const services = buildServices({ dbPath: ':memory:' }), { app } = buildApp(services);
  try {
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'room' });
    const rec = services.recordings.create({ roomId: room.id, roomName: 'room', platform: 'bilibili', streamSessionId: null, streamTitle: 'recording' });
    const file = path.join(dir, 'recording.mp4'), directory = path.join(dir, 'export');
    await mkdir(directory);
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    const store = await DanmakuStore.open(file);
    store.append({ id: 'a', tMs: 1000, wallMs: 1, text: '导出测试' });
    await store.close();
    const payload = { directory, durationMs: 10000, width: 1920, height: 1080, opacity: 0.9, density: 40 };
    const url = `/api/v1/recordings/${rec.id}/danmaku-export`;
    const response = await app.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({ count: 1, assCount: 1 });
    expect(await readFile(result.assPath, 'utf8')).toContain('\\move(');
    expect(await readFile(result.srtPath, 'utf8')).toContain('00:00:01,000');
    for (const invalid of [{ durationMs: 0 }, { width: -1 }, { opacity: 2 }, { density: 100 }, { directory: '' }]) {
      const bad = await app.inject({ method: 'POST', url, headers, payload: { ...payload, ...invalid } });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.code).toBe('CONFIG_INVALID');
    }
    services.recordings.update(rec.id, { state: 'recording' });
    const active = await app.inject({ method: 'POST', url, headers, payload });
    expect(active.statusCode).not.toBe(200);
    expect(active.json().error.code).toBe('RECORDING_NOT_AVAILABLE');
    expect((await readdir(directory)).sort()).toEqual(['recording.ass', 'recording.srt']);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
