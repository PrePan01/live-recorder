import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { buildApp } from '../../src/api/server.js';
import { hasPendingRecordingBuffer, recordingSpoolDirectory } from '../../src/recorder/buffered-writer.js';
import * as ffmpeg from '../../src/recorder/pipeline-ffmpeg.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

const fixtures: Array<{ root: string; services: Services }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, services } of fixtures.splice(0)) {
    services.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(contents = 'fir', offset = 0, buffered = 'first!') {
  const root = await mkdtemp(path.join(tmpdir(), 'lr-pipeline-buffer-'));
  const services = buildServices({ dbPath: path.join(root, 'fixture.db') });
  fixtures.push({ root, services });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'Recovery' });
  const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: null, streamTitle: 'Recovery' });
  const file = path.join(root, 'video.flv');
  await writeFile(file, contents);
  services.recordings.update(rec.id, { state: 'completed', filePath: file, fileSizeBytes: contents.length });
  const directory = recordingSpoolDirectory(services.recordingBufferDirectory, file);
  await mkdir(directory, { recursive: true });
  const spool = path.join(directory, `${offset}-abcd.buffer`);
  await writeFile(spool, buffered);
  // Keep the real API and queue while avoiding ffmpeg on this text fixture.
  vi.spyOn(services.pipeline as unknown as { pump(): void }, 'pump').mockImplementation(() => {});
  return { services, rec, file, spool };
}

describe('manual pipeline storage recovery', () => {
  it.each(['start', 'retry'])('%s replays retained bytes and queues without restarting the app', async (action) => {
    const { services, rec, file } = await setup();
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/${action}`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe('queued');
      expect(await readFile(file, 'utf8')).toBe('first!');
      expect(hasPendingRecordingBuffer(services.recordingBufferDirectory, file)).toBe(false);
      expect(services.recordings.get(rec.id)?.fileSizeBytes).toBe(6);
    } finally { await app.close(); }
  });

  it('clears an already-written buffer without duplicating media, including concurrent checks', async () => {
    const { services, file } = await setup('first!');
    expect(await Promise.all([services.pipeline.quickMediaCheck(file), services.pipeline.quickMediaCheck(file)])).toEqual([{ ok: true }, { ok: true }]);
    expect(await readFile(file, 'utf8')).toBe('first!');
    expect(hasPendingRecordingBuffer(services.recordingBufferDirectory, file)).toBe(false);
  });

  it.each([
    ['start', 'abc', 5, 'def', '缺少媒体数据'],
    ['retry', 'wrong!', 0, 'first!', '内容不一致'],
  ] as const)('%s processes saved media and retains unsafe recovery data', async (action, contents, offset, buffered, reason) => {
    const { services, rec, file, spool } = await setup(contents, offset, buffered);
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/${action}`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe('queued');
      expect(services.alerts.list().some(alert => alert.message.includes(reason) && alert.message.includes('将处理已保存的录像'))).toBe(true);
      expect(await readFile(spool, 'utf8')).toBe(buffered);
      expect(await readFile(file, 'utf8')).toBe(contents);
      expect(services.pipeline.repo.runForRecording(rec.id)?.status).toBe('queued');
    } finally { await app.close(); }
  });

  it('resumes an existing interrupted run even when replay fails', async () => {
    const { services, rec } = await setup('abc', 5, 'def');
    const run = services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: {} });
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/start`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.id).toBe(run.id);
      expect(services.recordings.get(rec.id)?.state).toBe('processing');
    } finally { await app.close(); }
  });

  it.each(['missing', 'empty'])('still refuses a %s file when replay fails', async (kind) => {
    const { services, rec, file, spool } = await setup('abc', 5, 'def');
    if (kind === 'missing') await rm(file);
    else await writeFile(file, '');
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/start`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.message).toContain('文件为空或不存在');
      expect(await readFile(spool, 'utf8')).toBe('def');
      expect(services.pipeline.repo.runForRecording(rec.id)).toBeNull();
    } finally { await app.close(); }
  });

  it('completes processing without deleting the original recovery target', async () => {
    const { services, rec, file, spool } = await setup('abc', 5, 'def');
    const converted = path.join(path.dirname(file), 'video.mp4');
    await writeFile(converted, 'converted');
    vi.spyOn(ffmpeg, 'convertToMp4').mockResolvedValue({ outPath: converted, sizeBytes: 9 });
    vi.spyOn(services.uploader, 'enqueue').mockResolvedValue(null);
    const settings = services.settings.load() ?? structuredClone(DEFAULT_SETTINGS);
    services.settings.save({ ...settings, pipeline: { ...services.pipeline.pipelineConfig(), enabled: true, verify: false, exportCover: false, outputFormat: 'mp4', deleteSourceAfterConvert: true } });
    vi.mocked((services.pipeline as unknown as { pump(): void }).pump).mockRestore();
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/start`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(services.pipeline.repo.runForRecording(rec.id)?.status).toBe('ok'), { timeout: 5000 });
      expect(await readFile(file, 'utf8')).toBe('abc');
      expect(await readFile(spool, 'utf8')).toBe('def');
      expect(services.recordings.get(rec.id)?.filePath).toBe(converted);
    } finally { await app.close(); }
  });

  it.each(['start', 'retry'])('%s refuses to replay while recording is active', async (action) => {
    const { services, rec, file, spool } = await setup();
    services.recordings.update(rec.id, { state: 'recording' });
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/${action}`, headers: { host: '127.0.0.1:43120' } });
      expect(response.statusCode).toBe(409);
      expect(await readFile(file, 'utf8')).toBe('fir');
      expect(await readFile(spool, 'utf8')).toBe('first!');
    } finally { await app.close(); }
  });
});
