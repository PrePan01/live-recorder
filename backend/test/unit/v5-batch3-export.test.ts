import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
}

describe('V5 Batch3 #127: backups & export', () => {
  it('creates export job, packages files + manifest, partial on missing', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const base = await mkdtemp(path.join(tmpdir(), 'lr-exp-'));
    const recDir = await mkdtemp(path.join(tmpdir(), 'lr-rec-'));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'e' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'e1', streamTitle: 't' });
    const file = path.join(recDir, 'x.flv');
    await writeFile(file, 'file-data');
    services.recordings.update(rec.id, { state: 'completed', filePath: file, metadata: { durationMs: 1000, segmentCount: 1, quality: '1080p', size: 9 } });
    // 缺失录制 → partial。
    const missingRec = services.recordings.create({ roomId: room.id, roomName: 'm', platform: 'bilibili', streamSessionId: 'm1', streamTitle: 'm' });

    const create = await inj({ method: 'POST', url: '/api/v1/exports', payload: { recordingIds: [rec.id, missingRec.id], baseDir: base } });
    expect(create.statusCode).toBe(201);
    const job = create.json().export;
    expect(job.id.startsWith('exp_')).toBe(true);
    expect(job.status).toBe('queued');

    // 等待异步完成。
    await new Promise((r) => setTimeout(r, 100));
    const detail = (await inj({ method: 'GET', url: `/api/v1/exports/${job.id}` })).json().export;
    expect(['ok', 'partial']).toContain(detail.status);
    expect(detail.outputPath).not.toBeNull();
    const manifestRaw = await readFile(path.join(detail.outputPath, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as { version: string; recordings: Array<{ id: string; file: string | null; hash: string | null; status: string }> };
    expect(manifest.version).toBe('1');
    expect(manifest.recordings).toHaveLength(2);
    expect(manifest.recordings[0]!.file).toBe('x.flv');
    expect(manifest.recordings[0]!.status).toBe('ok');
    // #136：manifest 含源文件 SHA-256 哈希。
    expect(manifest.recordings[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.recordings[1]!.status).toBe('partial');
    await app.close();
  });

  it('export endpoints validate + 404 + cancel', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const inj = host(app);
    const base = await mkdtemp(path.join(tmpdir(), 'lr-exp2-'));

    const bad = await inj({ method: 'POST', url: '/api/v1/exports', payload: { recordingIds: [], baseDir: base } });
    expect(bad.statusCode).toBe(500);
    const noBase = await inj({ method: 'POST', url: '/api/v1/exports', payload: { recordingIds: ['rec_x'] } });
    expect(noBase.statusCode).toBe(500);

    const list = (await inj({ method: 'GET', url: '/api/v1/exports' })).json();
    expect(Array.isArray(list.exports)).toBe(true);

    const missing = await inj({ method: 'GET', url: '/api/v1/exports/exp_none' });
    expect(missing.statusCode).toBe(404);
    const cancelMissing = await inj({ method: 'POST', url: '/api/v1/exports/exp_none/cancel' });
    expect(cancelMissing.statusCode).toBe(404);
    await app.close();
  });
});