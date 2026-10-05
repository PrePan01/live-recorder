/** Real HTTP + real recording engine soak. Default 24h, isolated temp files.
 * LR_RECORDING_SOAK_MS=60000 gives a smoke run; report records actual wall time.
 * Requires ffmpeg/ffprobe on PATH to generate and decode an actual AVC/AAC stream. */
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { StreamRecordingEngine } from "../dist/recorder/stream-recorder.js";
const run = promisify(execFile);
const durationMs = Number(
  process.env.LR_RECORDING_SOAK_MS ?? 24 * 60 * 60 * 1000,
);
if (!Number.isFinite(durationMs) || durationMs < 1000)
  throw new Error("invalid soak duration");
const root = await mkdtemp(path.join(tmpdir(), "lr-recording-soak-"));
const reportPath =
  process.env.LR_RECORDING_SOAK_REPORT ?? path.join(root, "report.json");
await run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=160x90:rate=10",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=44100",
  "-t",
  "3",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  "-bf",
  "0",
  "-g",
  "10",
  "-c:a",
  "aac",
  "-f",
  "flv",
  path.join(root, "fixture.flv"),
]);
const fixture = await readFile(path.join(root, "fixture.flv"));
const tags = [];
for (let offset = 13; offset + 11 <= fixture.length;) {
  const length = 15 + fixture.readUIntBE(offset + 1, 3);
  if (offset + length > fixture.length) throw new Error("invalid fixture");
  const tag = fixture.subarray(offset, offset + length);
  const type = tag[0];
  if (type === 8 || type === 9)
    tags.push({
      data: Buffer.from(tag),
      ts: tag.readUIntBE(4, 3) + tag[7] * 0x1000000,
      sequence: tag[12] === 0,
    });
  offset += length;
}
const init = tags.filter((t) => t.sequence).map((t) => t.data);
const media = tags.filter((t) => !t.sequence);
const period = Math.max(...media.map((t) => t.ts)) + 23;
let connections = 0;
let running = true;
const openResponses = new Set();
const server = createServer((_req, res) => {
  connections++;
  openResponses.add(res);
  res.writeHead(200, { "Content-Type": "video/x-flv" });
  res.write(Buffer.concat([fixture.subarray(0, 13), ...init]));
  const start = performance.now();
  let cycle = 0,
    index = 0;
  const tick = () => {
    if (res.destroyed || !running) return;
    const elapsed = performance.now() - start;
    // Eight seconds of legitimate source pause: must retain the connection.
    const pauseStart = Math.min(20000, durationMs / 3);
    if (elapsed >= pauseStart && elapsed < pauseStart + 8000) return;
    while (cycle * period + media[index].ts <= elapsed) {
      const packet = Buffer.from(media[index].data);
      const timestamp =
        (24 * 60 * 60 * 1000 + cycle * period + media[index].ts) >>> 0;
      packet.writeUIntBE(timestamp & 0xffffff, 4, 3);
      packet[7] = timestamp >>> 24;
      const ready = res.write(packet);
      if (++index === media.length) {
        index = 0;
        cycle++;
      }
      if (!ready) return;
    }
  };
  const timer = setInterval(tick, 25);
  res.on("close", () => {
    clearInterval(timer);
    openResponses.delete(res);
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const url = `http://127.0.0.1:${server.address().port}/live.flv`;
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const engines = Array.from(
  { length: 4 },
  () =>
    new StreamRecordingEngine(fetch, undefined, {
      directory: path.join(root, "buffer"),
      memoryBytes: 64 * 1024,
    }),
);
const failures = [];
const files = engines.map((_, i) => path.join(root, `recording-${i}.flv`));
const startedAt = new Date().toISOString();
const start = performance.now();
const jobs = engines.map(async (engine, i) => {
  let packets = 0;
  for await (const event of engine.start({ url, format: "flv" }, files[i])) {
    if (event.type === "error") failures.push(event.error);
    // Exercise suspension by a slow preview consumer, independent of disk.
    if (event.type === "preview_data" && ++packets % 11 === 0)
      await new Promise((r) => setTimeout(r, 80));
  }
});
const samples = [];
const sample = async () => {
  samples.push({
    elapsedMs: Math.round(performance.now() - start),
    ...process.memoryUsage(),
  });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        state: "running",
        startedAt,
        durationMs,
        root,
        connections,
        failures,
        samples: samples.slice(-1000),
      },
      null,
      2,
    ),
  );
};
let reporting = Promise.resolve();
const sampler = setInterval(() => {
  reporting = reporting.then(sample);
}, 5000);
console.log(JSON.stringify({ root, reportPath, durationMs, pid: process.pid }));
try {
  await sample();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  running = false;
  await Promise.all(engines.map((engine) => engine.stop()));
  await Promise.all(jobs);
  clearInterval(sampler);
  await reporting;
  lag.disable();
  const recordings = [];
  for (const file of files) {
    const probe = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ]);
    const decoded = await run(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "null", "-"],
      { maxBuffer: 1024 * 1024 },
    );
    const seconds = Number(JSON.parse(probe.stdout).format.duration);
    if (decoded.stderr.trim())
      throw new Error(`decode errors: ${decoded.stderr}`);
    if (Math.abs(seconds * 1000 - durationMs) > 5000)
      throw new Error(`duration mismatch ${seconds}s`);
    recordings.push({
      file,
      bytes: (await stat(file)).size,
      seconds,
      decode: "ok",
    });
  }
  const report = {
    state: failures.length || connections !== 4 ? "failed" : "passed",
    startedAt,
    endedAt: new Date().toISOString(),
    wallTimeMs: Math.round(performance.now() - start),
    root,
    connections,
    failures,
    recordings,
    p95EventLoopDelayMs: lag.percentile(95) / 1e6,
    first: samples[0],
    last: samples.at(-1),
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.state !== "passed") process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await reporting.catch(() => undefined);
  lag.disable();
  running = false;
  await Promise.all(engines.map((engine) => engine.stop()));
  for (const response of openResponses) response.destroy();
  await Promise.allSettled(jobs);
  await new Promise((resolve) => server.close(resolve));
}
