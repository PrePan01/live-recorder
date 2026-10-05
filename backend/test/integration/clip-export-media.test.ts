import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportClipFile } from '../../src/recorder/clip-export.js';
import { openFlvClipSource, prepareFlvClipInput } from '../../src/recorder/flv-clip-input.js';
import { runFfmpegTracked } from '../../src/recorder/ffmpeg-run.js';
import { scanSeekIndex, SeekIndexWriter, seekSidecarPath } from '../../src/storage/seek-index.js';
import { resolveBin } from '../../src/utils/ffmpeg.js';

const ffmpeg = resolveBin('ffmpeg');
const ffprobe = resolveBin('ffprobe');
const hasMediaTools = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
const passthroughArgs = spawnSync(ffmpeg, ['-h', 'full'], { maxBuffer: 4 * 1024 * 1024 }).stdout?.includes(Buffer.from('-fps_mode'))
  ? ['-fps_mode', 'passthrough'] : ['-vsync', '0'];

function run(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

async function index(file: string): Promise<void> {
  const writer = await SeekIndexWriter.open(file, 0);
  if (!writer) throw new Error('Cannot create test index');
  await scanSeekIndex(file, { from: 0, to: (await stat(file)).size, onEntry: entry => writer.note(entry) });
  await writer.close();
}

function frameTimes(file: string): number[] {
  const result = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return (JSON.parse(result.stdout.toString()).frames as Array<{ best_effort_timestamp_time: string }>).map(frame => Number(frame.best_effort_timestamp_time));
}

// 每帧亮度 N 单调递增：比较真实解码后的画面，而非只检查输出容器声称的 duration。
function luminance(file: string): Buffer {
  return run(['-xerror', '-i', file, '-vf', 'scale=1:1,format=gray', ...passthroughArgs, '-f', 'rawvideo', 'pipe:1']);
}

describe.skipIf(!hasMediaTools)('real clip media / one-second selection contract', () => {
  let dir: string;
  let source: string;
  let values: Buffer;
  let times: number[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lr-clip-media-'));
    source = path.join(dir, 'source.flv');
    run(['-f', 'lavfi', '-i', 'nullsrc=size=160x90:rate=25,geq=lum=16+N:cb=128:cr=128',
      '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000', '-t', '8',
      '-c:v', 'libx264', '-preset', 'fast', '-threads', '2', '-crf', '18',
      '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '3', '-c:a', 'aac', '-y', source]);
    await index(source);
    values = luminance(source);
    times = frameTimes(source);
    expect(values.length).toBe(times.length);
  }, 30_000);

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  function assertFrames(output: string, start: number, end: number, tolerance: number): void {
    const actual = luminance(output);
    expect(actual.length).toBeGreaterThan(1);
    const match = (value: number) => {
      let best = 0;
      for (let i = 1; i < values.length; i++) if (Math.abs(values[i]! - value) < Math.abs(values[best]! - value)) best = i;
      return times[best]!;
    };
    expect(Math.abs(match(actual[0]!) - start)).toBeLessThan(tolerance);
    expect(Math.abs(match(actual[actual.length - 1]!) + 1 / 25 - end)).toBeLessThan(tolerance);
  }

  it('copies an IDR near selection and verifies actual first/last decoded frames with B frames', async () => {
    const output = path.join(dir, 'copy.flv');
    const result = await exportClipFile(source, output, 2.25, 5.8);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.method).toBe('copy');
    const stream = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', output]);
    expect(stream.stdout.toString().trim()).toBe('25/1');
    assertFrames(output, 2.25, 5.8, 0.8);
  });

  it('uses precise encoding when no nearby keyframe can satisfy the contract', async () => {
    const output = path.join(dir, 'exact.flv');
    const result = await exportClipFile(source, output, 3.2, 6.1);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.method).toBe('encode');
    assertFrames(output, 3.2, 6.1, 0.15);
  });

  it('keeps short one-second selections inside the boundary contract around keyframes', async () => {
    for (const start of [0, 1.45, 1.6, 1.9, 2, 2.49, 2.6, 2.95]) {
      const output = path.join(dir, `boundary-${start}.flv`);
      const result = await exportClipFile(source, output, start, start + 1);
      expect(result.ok, result.stderr).toBe(true);
      assertFrames(output, start, start + 1, 0.8);
    }
  });

  it('falls back for missing/stale index and preserves media-relative semantics for a nonzero origin', async () => {
    const missing = path.join(dir, 'missing.flv');
    await copyFile(source, missing);
    const output = path.join(dir, 'missing-out.flv');
    const result = await exportClipFile(missing, output, 3.2, 6.1);
    expect(result.ok, result.stderr).toBe(true);
    assertFrames(output, 3.2, 6.1, 0.15);
    const stale = await readFile(seekSidecarPath(source), 'utf8');
    await writeFile(seekSidecarPath(missing), stale.replace(/"b":(\d+)/g, (_, byte: string) => `"b":${Number(byte) + 7}`));
    const staleOutput = path.join(dir, 'stale-out.flv');
    const staleResult = await exportClipFile(missing, staleOutput, 2.25, 5.8);
    expect(staleResult.ok, staleResult.stderr).toBe(true);
    expect(staleResult.method).toBe('encode');
    assertFrames(staleOutput, 2.25, 5.8, 0.15);
    const shifted = path.join(dir, 'shifted.flv');
    run(['-i', source, '-c', 'copy', '-output_ts_offset', '7.5', '-y', shifted]);
    await index(shifted);
    const shiftedOutput = path.join(dir, 'shifted-out.flv');
    const shiftedResult = await exportClipFile(shifted, shiftedOutput, 3.2, 6.1);
    expect(shiftedResult.ok, shiftedResult.stderr).toBe(true);
    assertFrames(shiftedOutput, 3.2, 6.1, 0.15);
    const shiftedCopy = path.join(dir, 'shifted-copy.flv');
    const shiftedCopyResult = await exportClipFile(shifted, shiftedCopy, 2.25, 5.8);
    expect(shiftedCopyResult.ok, shiftedCopyResult.stderr).toBe(true);
    expect(shiftedCopyResult.method).toBe('copy');
    assertFrames(shiftedCopy, 2.25, 5.8, 0.8);
  });

  it('holds a snapshot across source rename and ignores an incomplete growing tail tag', async () => {
    const growing = path.join(dir, 'growing.flv');
    await copyFile(source, growing);
    await index(growing);
    await truncate(growing, (await stat(growing)).size - 6);
    const snapshot = await openFlvClipSource(growing);
    expect(snapshot).not.toBeNull();
    const plan = await prepareFlvClipInput(snapshot!, 2.25, 5.8, true);
    expect(plan?.copySafe).toBe(true);
    await rename(growing, path.join(dir, 'moved.flv'));
    const output = path.join(dir, 'snapshot.flv');
    try {
      const result = await runFfmpegTracked(['-y', '-f', 'flv', '-i', 'pipe:0', '-t', String(5.8 - plan!.keyframeSecond), '-c', 'copy', output], { input: plan!.createStream });
      expect(result.ok, result.stderr).toBe(true);
      assertFrames(output, 2.25, 5.8, 0.8);
    } finally { await snapshot!.close(); }
  });

  it('supports no audio, audio only and a source container without FLV indexing', async () => {
    const silent = path.join(dir, 'silent.flv');
    run(['-i', source, '-an', '-c', 'copy', '-y', silent]);
    await index(silent);
    const silentOutput = path.join(dir, 'silent-out.flv');
    const silentResult = await exportClipFile(silent, silentOutput, 2.25, 5.8);
    expect(silentResult.ok, silentResult.stderr).toBe(true);
    assertFrames(silentOutput, 2.25, 5.8, 0.8);
    const audio = path.join(dir, 'audio.flv');
    run(['-i', source, '-vn', '-c', 'copy', '-y', audio]);
    const audioResult = await exportClipFile(audio, path.join(dir, 'audio-out.flv'), 2.25, 5.8);
    expect(audioResult.ok, audioResult.stderr).toBe(true);
    const mp4 = path.join(dir, 'source.mp4');
    run(['-i', source, '-c', 'copy', '-y', mp4]);
    const mp4Output = path.join(dir, 'mp4-out.mp4');
    const mp4Result = await exportClipFile(mp4, mp4Output, 3.2, 6.1);
    expect(mp4Result.ok, mp4Result.stderr).toBe(true);
    assertFrames(mp4Output, 3.2, 6.1, 0.15);
  });

  it('does not report a short EOF selection as successful or leave partial output', async () => {
    const output = path.join(dir, 'short.flv');
    const result = await exportClipFile(source, output, 6.4, 10.5);
    expect(result.ok).toBe(false);
    await expect(stat(output)).rejects.toThrow();
  });

  it('preserves a valid video selection when audio starts late', async () => {
    const delayed = path.join(dir, 'late-audio.flv');
    run(['-i', source, '-itsoffset', '3', '-i', source, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-y', delayed]);
    await index(delayed);
    const output = path.join(dir, 'late-audio-out.flv');
    const result = await exportClipFile(delayed, output, 2.25, 5.8);
    expect(result.ok, result.stderr).toBe(true);
    assertFrames(output, 2.25, 5.8, 0.8);
  });

  it('cancels active input/encoding and does not spawn work for a pre-cancelled selection', async () => {
    const abort = new AbortController();
    const output = path.join(dir, 'cancel.flv');
    const job = exportClipFile(source, output, 3.2, 7.1, { signal: abort.signal, onProgress: () => abort.abort() });
    const result = await job;
    expect(abort.signal.aborted).toBe(true);
    expect(result.ok).toBe(false);
    await expect(stat(output)).rejects.toThrow();
    const before = new AbortController();
    before.abort();
    expect((await exportClipFile(source, output, 1, 5, { signal: before.signal })).ok).toBe(false);
  });
});
