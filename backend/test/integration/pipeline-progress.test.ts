import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';
import * as ffmpeg from '../../src/recorder/pipeline-ffmpeg.js';
import type { FfmpegRunOptions } from '../../src/recorder/ffmpeg-run.js';
import type { PipelineRun } from '../../src/types/index.js';
import { resolveBin } from '../../src/utils/ffmpeg.js';

it('publishes conversion and compression percentages independently of overall progress', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lr-pipeline-progress-'));
  const clock = new FakeClock(Date.now());
  const services = buildServices({ dbPath: path.join(directory, 'test.db'), clock });
  const { app } = buildApp(services);
  try {
    const file = path.join(directory, 'sample.flv');
    execFileSync(resolveBin('ffmpeg'), [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:r=10:d=2', '-c:v', 'libx264', file,
    ], { timeout: 10_000 });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'Progress' });
    const recording = services.recordings.create({
      roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: null, streamTitle: 'Progress',
    });
    services.recordings.update(recording.id, { state: 'completed', filePath: file });
    services.settings.save({
      ...(services.settings.load() ?? structuredClone(DEFAULT_SETTINGS)),
      pipeline: {
        ...services.pipeline.pipelineConfig(), enabled: true, verify: false, exportCover: false, outputFormat: 'mp4', crf: 23,
      },
    });

    const detailUrl = `/api/v1/recordings/${recording.id}/pipeline`;
    const snapshots: PipelineRun[] = [];
    const events: PipelineRun[] = [];
    services.events.on((event) => {
      if (event.type === 'pipeline:updated') events.push(event.data.run);
    });
    const report = async (options: FfmpegRunOptions | undefined, fraction: number) => {
      const durationMs = services.recordings.get(recording.id)?.metadata?.durationMs ?? 0;
      options?.onProgress?.({ outTimeMs: durationMs * fraction, speed: 1 });
      const response = await app.inject({ method: 'GET', url: detailUrl, headers: { host: '127.0.0.1:43120' } });
      snapshots.push(response.json<{ run: PipelineRun }>().run);
    };
    const convert = ffmpeg.convertToMp4;
    const compress = ffmpeg.compressOrRemux;
    vi.spyOn(ffmpeg, 'convertToMp4').mockImplementation(async (input, options) => {
      await report(options, 0.25);
      clock.advance(1_000);
      await report(options, 0.75);
      return convert(input, options);
    });
    vi.spyOn(ffmpeg, 'compressOrRemux').mockImplementation(async (input, crf, options) => {
      await report(options, 0.5);
      return compress(input, crf, { ...options, encodingMode: 'software' });
    });

    services.pipeline.enqueue(recording.id);
    await vi.waitFor(() => expect(services.pipeline.busy).toBe(false), { timeout: 10_000 });
    expect(services.pipeline.repo.runForRecording(recording.id)?.status).toBe('ok');

    const measuredProgress = ({ progressStep, progressPct, stepProgressPct }: PipelineRun) =>
      [progressStep, progressPct, stepProgressPct];
    expect(snapshots.map(measuredProgress)).toEqual([
      ['convert', 21, 25],
      ['convert', 34, 75],
      ['compress', 50, 50],
    ]);
    expect(events.map(measuredProgress)).toEqual(expect.arrayContaining(snapshots.map(measuredProgress)));
    expect(events.find((run) => run.progressStep === 'compress')?.stepProgressPct).toBeNull();
  } finally {
    vi.restoreAllMocks();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
