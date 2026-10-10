import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { buildApp } from '../../src/api/server.js';
const headers = { host: '127.0.0.1:43120' };
afterEach(() => vi.restoreAllMocks());
it('returns evidence, subtracts earlier missing time, and summarizes without loading each gap list', async () => {
  const services = buildServices({ dbPath: ':memory:' }), { app } = buildApp(services);
  try {
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'room' });
    const rec = services.recordings.create({ roomId: room.id, roomName: 'room', platform: 'bilibili', streamSessionId: null, streamTitle: 'recording' });
    const at = (second: number) => new Date(Date.parse(rec.startedAt) + second * 1000).toISOString();
    services.recordings.insertGap({ recordingId: rec.id, startedAt: at(60), endedAt: at(120), missingMs: 60000, kind: 'source_stall' });
    const evidence = JSON.stringify({ cause: { code: 'NETWORK_UNAVAILABLE' } });
    services.recordings.insertGap({ recordingId: rec.id, startedAt: at(180), endedAt: at(190), missingMs: 10000, kind: 'stream_disconnect', evidence });
    const gaps = (await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec.id}/gaps`, headers })).json();
    expect(gaps.gaps[1]).toMatchObject({ positionMs: 120000, estimated: true, evidence });
    const lists = vi.spyOn(services.recordings, 'listGaps');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/recordings', headers })).json();
    expect(list.items[0].gapSummary).toMatchObject({ gapCount: 2, totalMissingMs: 70000 });
    expect(lists).not.toHaveBeenCalled();
    const empty = (await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec.id}/danmaku`, headers })).json();
    expect(empty.status).toMatchObject({ recordingId: rec.id, state: 'unavailable' });
    const bad = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec.id}/danmaku?cursor=-1`, headers });
    expect(bad.statusCode).toBe(422);
  } finally { await app.close(); }
});
it('restores explicit room danmaku settings on both new and existing rooms', async () => {
  const services = buildServices({ dbPath: ':memory:' }), { app } = buildApp(services);
  try {
    for (const setting of [true, false, null]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers,
        payload: { config: { rooms: [{ platform: 'bilibili', url: 'https://live.bilibili.com/101', danmakuEnabled: setting }] } } });
      expect(response.statusCode).toBe(200); expect(services.rooms.list()[0]?.danmakuEnabled).toBe(setting);
    }
  } finally { await app.close(); }
});

it('keeps history and playback aware of legacy danmaku after migrating both files to .danmaku', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-danmaku-layout-'));
  const services = buildServices({ dbPath: ':memory:' }), { app } = buildApp(services);
  try {
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'room' });
    const rec = services.recordings.create({ roomId: room.id, roomName: 'room', platform: 'bilibili', streamSessionId: null, streamTitle: 'recording' });
    services.recordings.update(rec.id, { state: 'completed', filePath: path.join(dir, 'rec.mp4') });
    const message = { id: 'old', tMs: 100, text: '旧弹幕' };
    const gaps = [{ fromMs: 0, toMs: 50, reason: 'disconnect' }];
    await writeFile(path.join(dir, 'rec.danmaku.jsonl'), JSON.stringify(message) + '\n');
    await writeFile(path.join(dir, 'rec.danmaku.jsonl.gaps.json'), JSON.stringify(gaps));
    const history = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers });
    expect(history.statusCode).toBe(200);
    expect(history.json().items[0].hasDanmaku).toBe(true);
    const response = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec.id}/danmaku?fromMs=0&toMs=1000`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toEqual([message]);
    expect(response.json().gaps).toEqual(gaps);
    expect(await readFile(path.join(dir, '.danmaku', 'rec.danmaku.jsonl'), 'utf8')).toContain('old');
    await expect(readFile(path.join(dir, 'rec.danmaku.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'rec.danmaku.jsonl.gaps.json'))).rejects.toThrow();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
