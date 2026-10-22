// Public-stream acceptance check. Uses an isolated database and temporary files;
// never opens the user's database or reads saved platform credentials.
import { mkdtemp, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { resolveBin } from '../dist/utils/ffmpeg.js';
import { WebSocket } from 'ws';
import { buildServices } from '../dist/core/services.js';
import { buildApp } from '../dist/api/server.js';
import { DEFAULT_SETTINGS } from '../dist/config/defaults.js';
import { MemorySecretStore } from '../dist/security/memory-store.js';
import { DanmakuStore } from '../dist/danmaku/store.js';

process.env.LIVE_RECORDER_DEVELOPMENT = process.argv.includes('--no-diagnostics') ? '0' : '1';
if (process.argv.includes('--no-diagnostics')) process.env.NODE_ENV = 'production';

const url = process.argv[2];
if (!url) throw new Error('Usage: node backend/scripts/youtube-live-smoke.mjs <public-live-url>');
const recordFirst = process.argv.includes('--record-first');
const directory = await mkdtemp(path.join(tmpdir(), 'lr-youtube-live-smoke-'));
console.log(JSON.stringify({ directory }));
const services = buildServices({ mode: 'real', dbPath: path.join(directory, 'smoke.db') });
services.secretStore = new MemorySecretStore();
services.platformCookie = async () => undefined;
services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: directory,
  quality: process.argv[3] ?? '720p', highlightEnabled: !recordFirst, encodingMode: 'software', danmaku: { enabled: true },
  diskGuard: { minFreeBytes: 0, minFreePercent: 0 } });
const { app } = buildApp(services);
let ws;
let phase = 'preview';
const received = { preview: 0, recording: 0, resumed: 0 };
const progress = [];
const headers = { host: '127.0.0.1:43120' };
const check = (ok, message) => { if (!ok) throw new Error(message); };
const waitFor = async (predicate, label, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(JSON.stringify({ passed: label }));
};
const api = async (method, resource, payload) => {
  const result = await app.inject({ method, url: `/api/v1${resource}`, headers, payload });
  check(result.statusCode < 300, `${method} ${resource}: ${result.statusCode} ${result.body.slice(0, 500)}`);
  return result;
};
try {
  const created = await api('POST', '/rooms', { url });
  const roomId = created.json().room.id;
  await api('POST', `/rooms/${roomId}/check`);
  const room = services.rooms.get(roomId);
  check(room.lastLiveStatus === 'live', `Expected live, got ${room.lastLiveStatus}; ${room.lastError ?? room.lastErrorMessage ?? ''}`);
  for (const kind of ['avatar', 'cover']) {
    const result = await api('GET', `/rooms/${roomId}/${kind}`);
    check(result.rawPayload.length > 100, `Empty ${kind}`);
    console.log(JSON.stringify({ passed: kind, bytes: result.rawPayload.length }));
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  let closing = false;
  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/preview/${roomId}${process.argv.includes('--progress') ? '?progress=1' : ''}`, { headers });
    ws.on('message', (data, binary) => {
      if (binary) received[phase] += data.length;
      else {
        const message = JSON.parse(data.toString());
        if (message.type === 'preview_progress') progress.push({ phase, stage: message.stage });
      }
    });
    ws.on('error', () => {});
    ws.on('close', code => {
      if (!closing) console.log(JSON.stringify({ phase, websocketClosed: code }));
      if (!closing && code === 1012) connect();
    });
  };
  let highlight;
  if (!recordFirst) {
    connect();
    await services.manager.enableHighlightBuffer(roomId);
    await waitFor(() => received.preview > 100_000, 'pure preview WebSocket');
    await waitFor(() => services.manager.highlightStatus(roomId).availableSeconds >= 2, 'highlight cache');
    highlight = await services.manager.exportHighlight(roomId, 1);
    await waitFor(() => services.recordings.get(highlight.recordingId)?.state === 'completed', 'highlight export');
  }
  phase = 'recording';
  await api('POST', `/rooms/${roomId}/start-recording`);
  if (recordFirst) {
    await waitFor(async () => {
      const rec = services.recordings.list({ roomId }).items.find(item => item.state === 'recording');
      return rec?.filePath && (await stat(rec.filePath)).size > 100_000 &&
        services.manager.recordingMediaTailSeconds(roomId, rec.id) >= 3;
    }, 'recording without a preview');
    connect();
  }
  await waitFor(async () => {
    const rec = services.recordings.list({ roomId }).items[0];
    return rec?.filePath && (await stat(rec.filePath)).size > 100_000 && received.recording > 100_000 &&
      services.manager.recordingMediaTailSeconds(roomId, rec.id) >= 3;
  }, 'preview to recording with native file and WebSocket');
  const active = services.recordings.list({ roomId }).items.find(item => item.state === 'recording');
  check(active, 'Missing active native recording');
  if (process.argv.includes('--progress')) {
    check(progress.some(item => item.stage === 'preview_encoder_started'), 'Missing real preview encoder stage');
    check(progress.some(item => item.stage === 'preview_media_ready'), 'Missing preview media readiness stage');
    console.log(JSON.stringify({ passed: 'preview loading progress', progress }));
  }
  if (process.argv.includes('--close-viewer')) {
    closing = true;
    const disconnected = once(ws, 'close'); ws.close(); await disconnected;
    const size = (await stat(active.filePath)).size;
    await waitFor(async () => (await stat(active.filePath)).size > size + 10_000,
      'native recording continues without viewers', 20_000);
    const previousBytes = received.recording;
    closing = false; connect();
    await waitFor(() => received.recording > previousBytes + 100_000, 'viewer rejoins the same native source');
  }
  let savedMessages = [];
  if (!process.argv.includes('--skip-chat')) await waitFor(async () => {
    const text = await readFile(DanmakuStore.sidecarPathFor(active.filePath), 'utf8').catch(() => '');
    savedMessages = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return savedMessages.some(message => typeof message.tMs === 'number' && message.tMs > 0);
  }, 'chat persistence with media timestamps', 45_000);
  await api('POST', `/recordings/${active.id}/markers`, { positionSeconds: 1, text: 'Smoke test' });
  const markerPosition = (await api('GET', `/recordings/${active.id}/marker-position`)).json();
  check(Number.isFinite(markerPosition.previewOffsetSeconds), 'Missing shared native preview clock offset');
  const warm = await api('POST', `/recordings/${active.id}/seek-prewarm`, { second: 1 });
  check(warm.statusCode === 202, 'Seek prewarm failed');
  const seek = await api('GET', `/recordings/${active.id}/seek-stream?second=1`);
  check(seek.rawPayload.subarray(0, 3).toString() === 'FLV', 'Invalid active seek stream');
  console.log(JSON.stringify({ passed: 'active seek and marker', chatMessages: savedMessages.length }));
  phase = 'resumed';
  await api('POST', `/rooms/${roomId}/stop-recording`);
  await waitFor(() => received.resumed > 100_000, 'recording stop resumes preview');
  const rec = services.recordings.get(active.id);
  check(rec.state === 'completed', `Expected completed, got ${rec.state}`);
  check(rec.fileSizeBytes > 100_000 && rec.metadata?.durationMs >= 3000, 'Missing recording metadata');
  const playback = await api('GET', `/recordings/${rec.id}/file?second=1`);
  check(playback.rawPayload.subarray(0, 3).toString() === 'FLV', 'Invalid history playback');
  for (const [name, data] of [['active-seek.flv', seek.rawPayload], ['history.flv', playback.rawPayload]]) {
    const file = path.join(directory, name);
    await writeFile(file, data);
    const probe = JSON.parse(execFileSync(resolveBin('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
    check(probe.streams.some(stream => stream.codec_type === 'video'), `Missing video: ${name}`);
    execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-threads', '1', '-i', file, '-t', '2', '-f', 'null', '-'], { stdio: 'pipe' });
  }
  closing = true;
  ws?.terminate();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ roomId, recordingId: rec.id,
    file: rec.filePath, state: rec.state, bytes: rec.fileSizeBytes, metadata: rec.metadata, received,
    playbackBytes: playback.rawPayload.length, chatMessages: savedMessages.length, highlightId: highlight?.recordingId,
    markerPosition, progress, diagnostics: services.manager.performance.recent() }, null, 2));
  console.log(JSON.stringify({ passed: 'application lifecycle', directory, received, playbackBytes: playback.rawPayload.length }));
} catch (error) {
  console.log(JSON.stringify({ diagnostics: services.manager.performance.recent(), received }));
  throw error;
} finally {
  ws?.terminate();
  await app.close();
}
