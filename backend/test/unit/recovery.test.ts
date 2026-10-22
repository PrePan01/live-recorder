import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { recordingSpoolDirectory } from '../../src/recorder/buffered-writer.js';
import { saveYoutubeParts } from '../../src/recorder/youtube-media.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

    const r1 = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's1', streamTitle: '有文件' });
    services.recordings.update(r1.id, { state: 'recording', filePath: goodFile, fileSizeBytes: 4 });
    const r2 = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's2', streamTitle: '无文件' });
    services.recordings.update(r2.id, { state: 'recording', filePath: path.join(dir, 'missing.flv') });
    const r3 = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's3', streamTitle: '无路径' });
    services.recordings.update(r3.id, { state: 'recording' });
    // #167 一致性：0 字节文件 → failed RECORDING_EMPTY（非 completed 空文件）
    const emptyFile = path.join(dir, 'empty.flv');
    await writeFile(emptyFile, Buffer.alloc(0));
    const r4 = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 's4', streamTitle: '空文件' });
    services.recordings.update(r4.id, { state: 'recording', filePath: emptyFile });

    expect(services.recordings.activeCount()).toBe(4);
    const n = await recoverStaleRecordings(services);
    expect(n).toBe(4);
    expect(services.recordings.activeCount()).toBe(0);
    expect(services.recordings.get(r1.id)!.state).toBe('completed');
    expect(services.recordings.get(r1.id)!.fileSizeBytes).toBe(4);
    expect(services.recordings.get(r2.id)!.state).toBe('failed');
    expect(services.recordings.get(r3.id)!.state).toBe('failed');
    expect(services.recordings.get(r2.id)!.failureReason?.code).toBe('RECORDING_START_FAILED');
    expect(services.recordings.get(r4.id)!.state).toBe('failed');
    expect(services.recordings.get(r4.id)!.failureReason?.code).toBe('RECORDING_EMPTY');
  });
});
it('releases all stale slots before filesystem recovery, including records beyond the first page', async () => {
  const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'recovery' });
  for (let i = 0; i < 125; i++) {
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: `old-${i}`, streamTitle: '' });
    services.recordings.update(rec.id, { state: 'recording', filePath: '/missing/file.flv' });
  }
  const recovery = recoverStaleRecordings(services);
  expect(services.recordings.activeCount()).toBe(0);
  expect(await recovery).toBe(125);
  services.db.close();
});
it.each(['saved', 'spooled'])('recovers a %s YouTube reconnect part when its original first connection has no file', async kind => {
  const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-youtube-recovery-'));
  const room = services.rooms.create({ platform: 'youtube', url: 'https://youtube.com/watch?v=abcdefghijk', displayName: 'Creator' });
  const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'youtube', streamSessionId: 'abcdefghijk', streamTitle: '' });
  const file = path.join(dir, 'native.mkv');
  const next = `${file}.part-1.mkv`;
  await writeFile(next, kind === 'saved' ? 'saved original' : '');
  if (kind === 'spooled') {
    const spool = recordingSpoolDirectory(services.recordingBufferDirectory, next);
    await mkdir(spool, { recursive: true });
    await writeFile(path.join(spool, 'manifest.json'), JSON.stringify({ version: 1, target: next, recordingId: rec.id }));
    await writeFile(path.join(spool, '0-abcd.buffer'), 'saved original');
  }
  await saveYoutubeParts(file, [{ path: file, offsetMs: 0, durationMs: 0 }, { path: next, offsetMs: 0, durationMs: 1000 }]);
  services.recordings.update(rec.id, { state: 'recording', filePath: file });
  const resume = vi.spyOn(services.manager, 'resumeRecoveredProcessing').mockImplementation(() => {});
  try {
    expect(await recoverStaleRecordings(services)).toBe(1);
    expect(services.recordings.get(rec.id)).toMatchObject({ state: 'completed', fileSizeBytes: 14 });
    expect(resume).toHaveBeenCalledWith(rec.id);
    expect(await readFile(next, 'utf8')).toBe('saved original');
  } finally { services.db.close(); await rm(dir, { recursive: true, force: true }); }
});
