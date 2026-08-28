import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { recoverStaleRecordings } from '../../src/core/recovery.js';

describe('recoverStaleRecordings (#82)', () => {
  it('marks stale recording sessions: file present→completed, missing→failed', async () => {
    const services = buildServices({ dbPath: ':memory:', clock: new FakeClock() });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-recover-'));
    await mkdir(dir, { recursive: true });
    const goodFile = path.join(dir, 'good.flv');
    await writeFile(goodFile, Buffer.from([0x46, 0x4c, 0x56, 0x01]));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'r' });

    const r1 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's1', streamTitle: '有文件' });
    services.recordings.update(r1.id, { state: 'recording', filePath: goodFile, fileSizeBytes: 4 });
    const r2 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's2', streamTitle: '无文件' });
    services.recordings.update(r2.id, { state: 'recording', filePath: path.join(dir, 'missing.flv') });
    const r3 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's3', streamTitle: '无路径' });
    services.recordings.update(r3.id, { state: 'recording' });

    expect(services.recordings.activeCount()).toBe(3);
    const n = await recoverStaleRecordings(services);
    expect(n).toBe(3);
    expect(services.recordings.activeCount()).toBe(0);
    expect(services.recordings.get(r1.id)!.state).toBe('completed');
    expect(services.recordings.get(r2.id)!.state).toBe('failed');
    expect(services.recordings.get(r3.id)!.state).toBe('failed');
    expect(services.recordings.get(r2.id)!.failureReason?.code).toBe('RECORDING_START_FAILED');
  });
});