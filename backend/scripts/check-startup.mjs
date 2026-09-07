// End-to-end sidecar check for the Node + backend actually included in an installer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const backend = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'lr startup 中文 '));
const ready = path.join(data, 'state/ready.json');
const occupied = createServer();
await new Promise((resolve, reject) => {
  occupied.once('error', reject);
  occupied.listen(0, '127.0.0.1', resolve);
});
const preferred = occupied.address().port;
let child;
let output = '';
async function stop(signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  await new Promise((resolve) => {
    const timer = setTimeout(() => current.kill('SIGKILL'), 5000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    current.kill(signal);
  });
}
async function start(port) {
  child = spawn(process.execPath, [path.join(backend, 'dist/index.js')], {
    cwd: backend,
    env: {
      ...process.env,
      LIVE_RECORDER_DATA_DIR: data,
      LIVE_RECORDER_STATE_DIR: path.join(data, 'state'),
      LIVE_RECORDER_READY_FILE: ready,
      LIVE_RECORDER_PORT: String(port),
      LIVE_RECORDER_DB: path.join(data, 'live-recorder.db'),
      RECORDING_ADAPTER: 'fake',
      // Offline/proxy failures must not affect the local boot sequence.
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`backend exited: ${output}`);
    const instance = await readFile(ready, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (instance?.pid === child.pid && instance.port > 0) {
      const response = await fetch(`${instance.baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(1500),
      }).catch(() => null);
      if (
        response?.ok &&
        (await response.json()).serviceStatus.instanceId === instance.instanceId
      ) {
        for (let i = 0; i < 25; i++) {
          const status = await fetch(
            `${instance.baseUrl}/api/v1/service/status`,
            { signal: AbortSignal.timeout(1500) },
          );
          assert.equal(status.status, 200);
        }
        console.log(
          `startup passed: ${Date.now() - started}ms, port=${instance.port}, pid=${instance.pid}`,
        );
        return instance;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`startup timeout: ${output}`);
}
try {
  const first = await start(preferred);
  assert.notEqual(first.port, preferred);
  await stop('SIGKILL'); // simulate a crash with stale ready/lock files
  const recovered = await start(0);
  assert.notEqual(recovered.instanceId, first.instanceId);
  await stop();
  const restarted = await start(0);
  assert.notEqual(restarted.instanceId, recovered.instanceId);
  await stop();
  console.log(
    'startup smoke passed: occupied port, OS assigned port, abrupt exit recovery, restart, Unicode paths, unavailable proxy',
  );
} finally {
  await stop();
  await new Promise((resolve) => occupied.close(resolve));
  await rm(data, { recursive: true, force: true, maxRetries: 3 });
}
