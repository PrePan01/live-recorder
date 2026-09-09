/**
 * Repeatable local API baseline. It deliberately uses deterministic fake data
 * rather than public platforms, so latency trends are comparable between
 * builds. Run after `npm --prefix backend run build`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { buildServices } from '../dist/core/services.js';
import { buildApp } from '../dist/api/server.js';

const ROOMS = 50;
const RECORDINGS = 10_000;
const SAMPLES = 100;
const base = await mkdtemp(path.join(tmpdir(), 'live-recorder-perf-'));
const databasePath = path.join(base, 'fixture.db');
const services = buildServices({ dbPath: databasePath });
const rooms = [];
for (let i = 0; i < ROOMS; i += 1) {
  rooms.push(services.rooms.create({
    platform: i % 2 ? 'douyin' : 'bilibili',
    url: i % 2 ? `https://live.douyin.com/${100000 + i}` : `https://live.bilibili.com/${100000 + i}`,
    displayName: `baseline-${i}`,
  }));
}
for (let i = 0; i < RECORDINGS; i += 1) {
  const room = rooms[i % rooms.length];
  const startedAt = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: `fixture-${i}`, streamTitle: `fixture ${i}` });
  services.recordings.update(rec.id, { state: 'completed', startedAt, endedAt: new Date(Date.parse(startedAt) + 30_000).toISOString(), fileSizeBytes: 1_000_000 });
}
const { app } = buildApp(services);

async function sample(name, request) {
  const times = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    const response = await app.inject(request());
    if (response.statusCode !== 200) throw new Error(`${name} failed: ${response.statusCode}`);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { p50Ms: Number(times[Math.floor(times.length * 0.5)].toFixed(2)), p95Ms: Number(times[Math.ceil(times.length * 0.95) - 1].toFixed(2)), maxMs: Number(times.at(-1).toFixed(2)) };
}

try {
  const report = {
    generatedAt: new Date().toISOString(),
    fixture: { rooms: ROOMS, recordings: RECORDINGS, samples: SAMPLES, platforms: ['bilibili', 'douyin'] },
    machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, memoryBytes: os.totalmem() },
    api: {
      historyPage: await sample('historyPage', () => ({ method: 'GET', url: '/api/v1/recordings?page=1&pageSize=100', headers: { host: '127.0.0.1:43120' } })),
      recordingStats: await sample('recordingStats', () => ({ method: 'GET', url: '/api/v1/stats/recordings?from=2025-12-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z', headers: { host: '127.0.0.1:43120' } })),
      roomInsights: await sample('roomInsights', () => ({ method: 'POST', url: '/api/v1/rooms/insights/batch', headers: { host: '127.0.0.1:43120' }, payload: { roomIds: rooms.map((room) => room.id) } })),
    },
  };
  // A saved report turns the same deterministic fixture into a release gate:
  // metrics that already meet their absolute target must still not regress by
  // more than 10% on the same machine/configuration.
  if (process.env.LR_PERF_BASELINE) {
    const baseline = JSON.parse(await readFile(process.env.LR_PERF_BASELINE, 'utf8'));
    for (const [name, result] of Object.entries(report.api)) {
      const prior = baseline?.api?.[name]?.p95Ms;
      if (typeof prior === 'number' && result.p95Ms > prior * 1.1) {
        throw new Error(`${name} P95 regressed: ${result.p95Ms}ms > ${Number((prior * 1.1).toFixed(2))}ms baseline gate`);
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await rm(base, { recursive: true, force: true });
}
