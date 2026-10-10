import { expect, it, vi } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import * as integrity from '../../src/recorder/integrity.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../src/types/settings.js';

it('old cancelled attempts cannot unregister replacements, bypass concurrency or lose their own cancellation signal', async () => {
  const services = buildServices({ dbPath: ':memory:' });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: '/tmp', pipeline: { ...DEFAULT_PIPELINE_CONFIG, maxConcurrency: 1 } });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'race' });
  const make = (name: string) => {
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: name, streamTitle: name });
    services.recordings.update(rec.id, { state: 'completed', filePath: `/tmp/${name}.mp4` });
    return rec.id;
  };
  const first = make('cancel-retry'), other = make('queued');
  const tasks: { signal: AbortSignal; resolve: () => void }[] = [];
  const internal = services.pipeline as unknown as {
    runInner(entry: { recordingId: string }, runId: string, signal: AbortSignal): Promise<void>;
    stepStart(run: { recordingId: string }, step: string, signal: AbortSignal): unknown;
    running: Set<string>;
  };
  const mock = vi.spyOn(internal, 'runInner').mockImplementation((_entry, _runId, signal) => new Promise<void>(resolve => tasks.push({ signal, resolve })));
  try {
    services.pipeline.enqueue(first, 0, true);
    services.pipeline.cancel(first);
    expect(services.recordings.get(first)?.pipelineStatus).toBe('failed');
    expect(services.pipeline.retry(first, true).ok).toBe(true);
    services.pipeline.enqueue(other, 0, true);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.signal.aborted).toBe(true);
    expect(tasks[1]!.signal.aborted).toBe(false);
    expect(() => internal.stepStart({ recordingId: first }, 'verify', tasks[0]!.signal)).toThrow();
    tasks[0]!.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(internal.running.has(first)).toBe(true);
    expect(services.recordings.get(first)?.state).toBe('processing');
    expect(tasks).toHaveLength(2); // the third task must remain queued
    services.pipeline.cancel(first);
    expect(tasks[1]!.signal.aborted).toBe(true); // replacement still has its controller
    tasks[1]!.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(tasks).toHaveLength(3);
    services.pipeline.cancel(other);
    tasks[2]!.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(services.pipeline.busy).toBe(false);
  } finally { mock.mockRestore(); services.db.close(); }
});

it('a cancelled integrity check settling late cannot publish failure over the retry', async () => {
  const services = buildServices({ dbPath: ':memory:' });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: '/tmp', pipeline: { ...DEFAULT_PIPELINE_CONFIG, maxConcurrency: 1 } });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: 'late-result' });
  const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: 'late', streamTitle: 'late' });
  services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/late-cancel.mp4' });
  const checks: ((result: 'failed') => void)[] = [];
  const check = vi.spyOn(integrity, 'checkFileIntegrity').mockImplementation(() => new Promise(resolve => checks.push(resolve)));
  try {
    services.pipeline.enqueue(rec.id, 0, true);
    services.pipeline.cancel(rec.id);
    const retry = services.pipeline.retry(rec.id, true);
    expect(checks).toHaveLength(2);
    checks[0]!('failed');
    await new Promise(resolve => setImmediate(resolve));
    expect(services.pipeline.repo.getRun(retry.run!.id)?.status).toBe('running');
    expect(services.recordings.get(rec.id)?.pipelineStatus).toBe('running');
    expect(services.alerts.list()).toHaveLength(0);
    services.pipeline.cancel(rec.id);
    checks[1]!('failed');
    await new Promise(resolve => setImmediate(resolve));
    expect(services.recordings.get(rec.id)?.pipelineStatus).toBe('failed');
    expect(services.pipeline.busy).toBe(false);
  } finally { check.mockRestore(); services.db.close(); }
});
