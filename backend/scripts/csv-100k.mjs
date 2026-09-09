/** Streaming CSV acceptance check: real file SQLite + worker export + HTTP body reader. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServices } from '../dist/core/services.js';
import { buildApp } from '../dist/api/server.js';

const count = Number(process.env.LR_CSV_ROWS ?? 100_000);
const port = Number(process.env.LR_CSV_PORT ?? 43_120);
const dir = await mkdtemp(path.join(tmpdir(), 'live-recorder-csv-'));
const services = buildServices({ dbPath: path.join(dir, 'fixture.db') });
const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/999999', displayName: 'CSV acceptance' });
// Fixture construction is intentionally a single transaction. Calling the
// business repository 200k times measures insert overhead, not CSV streaming.
const insert = services.db.prepare(`INSERT INTO recordings
  (id, room_id, room_name, platform, stream_session_id, stream_title, state, started_at, ended_at, file_size_bytes, retry_count, created_at)
  VALUES (?, ?, ?, 'bilibili', ?, ?, 'completed', ?, ?, 0, 0, ?)`);
services.db.transaction(() => {
  for (let i = 0; i < count; i += 1) {
    const startedAt = new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString();
    insert.run(`rec-csv-${i}`, room.id, room.displayName, `csv-${i}`, `row-${i}`, startedAt, new Date(Date.parse(startedAt) + 1_000).toISOString(), startedAt);
  }
})();
const { app } = buildApp(services);
let peakHeap = process.memoryUsage().heapUsed;
try {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no HTTP address');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/recordings/export`);
  if (!response.ok || !response.body) throw new Error(`CSV HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let rows = 0;
  let idChecksum = 0;
  let previousTime = '';
  let summary = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    const lines = (rest + value).split('\r\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line || line === 'id,roomId,platform,streamTitle,state,startedAt,endedAt,durationSec,fileSizeBytes,quality,integrity' || line.startsWith('\uFEFFid,')) continue;
      if (line.startsWith('total')) { summary += `${line}\n`; continue; }
      const columns = line.split(',');
      const match = /^rec-csv-(\d+)$/.exec(columns[0] ?? '');
      if (!match) throw new Error(`unexpected CSV id: ${columns[0]}`);
      idChecksum += Number(match[1]);
      const startedAt = columns[5] ?? '';
      if (previousTime && previousTime < startedAt) throw new Error('CSV stable descending order violated');
      previousTime = startedAt;
      rows += 1;
    }
  }
  const expectedChecksum = (count * (count - 1)) / 2;
  if (rows !== count || idChecksum !== expectedChecksum || !summary.includes(`totalRecordings,${count}`)) throw new Error(`CSV incomplete or duplicate: rows=${rows}, checksum=${idChecksum}, summary=${summary}`);
  console.log(JSON.stringify({ rows, idChecksum, peakHeapBytes: peakHeap, finalHeapBytes: process.memoryUsage().heapUsed, summary: summary.trim() }, null, 2));
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
