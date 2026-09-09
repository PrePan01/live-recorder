/**
 * Local mixed-workload soak harness. Default duration is the release gate's
 * 24 hours; use LR_SOAK_DURATION_MS for a short smoke run. It intentionally
 * uses fake adapters and app.inject so public-platform instability never
 * masquerades as a memory or event-loop regression.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServices } from '../dist/core/services.js';
import { buildApp } from '../dist/api/server.js';
import { DEFAULT_SETTINGS } from '../dist/config/defaults.js';

const durationMs = Number(process.env.LR_SOAK_DURATION_MS ?? 24 * 60 * 60 * 1000);
const intervalMs = Number(process.env.LR_SOAK_INTERVAL_MS ?? 5_000);
if (!Number.isFinite(durationMs) || durationMs < 1_000 || !Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('invalid soak duration/interval');
const dir = await mkdtemp(path.join(tmpdir(), 'live-recorder-soak-'));
const services = buildServices({ dbPath: path.join(dir, 'fixture.db') });
services.settings.save({ ...DEFAULT_SETTINGS, recordingDirectory: path.join(dir, 'recordings'), maxConcurrentRecordings: 4 });
const rooms = [];
for (let i = 0; i < 50; i += 1) rooms.push(services.rooms.create({ platform: i % 2 ? 'douyin' : 'bilibili', url: i % 2 ? `https://live.douyin.com/${200000 + i}` : `https://live.bilibili.com/${200000 + i}`, displayName: `soak-${i}` }));
const { app } = buildApp(services);
// Exercise the supported four-recording ceiling using actual fake FLV writes.
for (const room of rooms.slice(0, 4)) {
  services.rooms.setLiveStatus(room.id, 'live');
  await services.manager.maybeStartRecording(room, { streamSessionId: `soak-${room.id}`, streamTitle: `soak ${room.id}` }, { manual: true });
}
const samples = [];
let ticks = 0;
let expected = performance.now() + intervalMs;
const tick = async () => {
  const now = performance.now();
  const lagMs = Math.max(0, now - expected);
  expected = now + intervalMs;
  // A mixed iteration exercises list/history/stats/insights/search paths;
  // every fifth tick also starts checks over four selected rooms.
  await app.inject({ method: 'GET', url: '/api/v1/recordings?page=1&pageSize=100', headers: { host: '127.0.0.1:43120' } });
  await app.inject({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: { host: '127.0.0.1:43120' }, payload: { roomIds: rooms.map((room) => room.id) } });
  await app.inject({ method: 'GET', url: '/api/v1/search?q=soak&page=1&pageSize=20', headers: { host: '127.0.0.1:43120' } });
  if (ticks % 5 === 0) await Promise.all(rooms.slice(0, 4).map((room) => services.scheduler.triggerImmediateCheck(room.id).catch(() => undefined)));
  samples.push({ at: new Date().toISOString(), lagMs, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, handles: process._getActiveHandles?.().length ?? null });
  ticks += 1;
};
try {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const lag = samples.map((sample) => sample.lagMs).sort((a, b) => a - b);
  const report = { durationMs, intervalMs, ticks, p95EventLoopLagMs: lag[Math.max(0, Math.ceil(lag.length * .95) - 1)], first: samples[0], last: samples.at(-1), samples };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
