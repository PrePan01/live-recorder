// Public live startup timings with isolated temporary media; no saved credentials.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBin } from '../dist/utils/ffmpeg.js';
import { YoutubeAdapter } from '../dist/platform/youtube.js';
import { YoutubeRecordingEngine } from '../dist/recorder/youtube-recorder.js';
const url = process.argv[2];
if (!url) throw new Error('Usage: youtube-startup-benchmark.mjs <public-live-url> [label]');
const directory = await mkdtemp(path.join(tmpdir(), 'lr-youtube-startup-'));
const results = [];
const quality = process.argv[4] ?? '720p';
const modes = process.argv[5] ? [process.argv[5]] : ['recording', 'preview'];
if (modes.some(mode => !['recording', 'preview'].includes(mode))) throw new Error('Mode must be recording or preview');
for (const mode of modes) {
  const adapter = new YoutubeAdapter();
  const engine = new YoutubeRecordingEngine({}, 'software');
  engine.setPreviewActive(true);
  const started = performance.now();
  const result = { mode, quality, label: process.argv[3] ?? 'current', stages: [], previewChunks: [] };
  engine.setStartupObserver(stage => result.stages.push({ stage, elapsedMs: Math.round(performance.now() - started) }));
  const timer = setTimeout(() => void engine.stop(), 75_000);
  let chunks = [], previewBytes = 0;
  try {
    const input = await adapter.getStreamUrl(url, quality);
    result.metadataMs = Math.round(performance.now() - started);
    result.reusedExtraction = (input.youtube?.snapshot?.expiresAt ?? 0) > Date.now();
    for await (const event of engine.start(input, mode === 'recording' ? path.join(directory, 'capture.mkv') : null)) {
      const elapsed = Math.round(performance.now() - started);
      if (event.type === 'error') throw new Error(JSON.stringify(event.error));
      if (event.type === 'media_info') result.source = event.source;
      if (event.type === 'data' && mode === 'recording') result.nativeMs ??= elapsed;
      if (event.type === 'preview_data' || (event.type === 'data' && mode === 'preview')) {
        if (result.previewChunks.length < 4096) result.previewChunks.push({ elapsedMs: elapsed, bytes: event.chunk.length });
        result.previewMs ??= elapsed;
        chunks.push(event.chunk);
        previewBytes += event.chunk.length;
        if (previewBytes > 200_000 && elapsed - result.previewMs > 2500) { await engine.stop(); break; }
      }
    }
    if (!result.previewMs || (mode === 'recording' && !result.nativeMs)) throw new Error('No media before deadline');
    result.previewBytes = previewBytes;
    const previewFile = path.join(directory, `${mode}.flv`);
    await writeFile(previewFile, Buffer.concat(chunks));
    result.media = [];
    for (const file of [previewFile, ...(mode === 'recording' ? [path.join(directory, 'capture.mkv')] : [])]) {
      const probe = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
      if (!probe.streams.some(s => s.codec_type === 'video')) throw new Error('Missing video track');
      execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-threads', '1', '-i', file, '-t', '2', '-f', 'null', '-'], { stdio: 'pipe' });
      result.media.push({ file: path.basename(file), decoded: true,
        streams: probe.streams.map(s => ({ codec: s.codec_name, width: s.width, height: s.height })) });
    }
  } catch (error) { result.error = String(error); }
  finally { clearTimeout(timer); await engine.stop(); }
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(path.join(directory, 'result.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ directory }));
if (results.some(r => r.error)) process.exitCode = 1;
