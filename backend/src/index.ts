import { startSidecar, installShutdownSignals, watchParentExit } from './sidecar/start.js';
import { DEFAULT_HOST } from './sidecar/types.js';
import { DEFAULT_PORT } from './sidecar/ports.js';
import path from 'node:path';
import { defaultDataDir } from './core/services.js';

const env = process.env;

const host = env.LIVE_RECORDER_HOST ?? DEFAULT_HOST;
const preferredPort = env.LIVE_RECORDER_PORT ? Number(env.LIVE_RECORDER_PORT) : DEFAULT_PORT;
const readyFile = env.LIVE_RECORDER_READY_FILE;
const stateDir = env.LIVE_RECORDER_STATE_DIR ?? path.join(defaultDataDir(), 'state');
const instanceId = env.LIVE_RECORDER_INSTANCE_ID;
const dbPath = env.LIVE_RECORDER_DB;
const extraOrigins = (env.LR_EXTRA_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean);

async function main(): Promise<void> {
  const options: Parameters<typeof startSidecar>[0] = {
    host,
    preferredPort,
    stateDir,
    extraOrigins,
    mode: env.RECORDING_ADAPTER === 'fake' ? 'fake' : 'real',
  };
  if (readyFile) options.readyFile = readyFile;
  if (instanceId) options.instanceId = instanceId;
  if (dbPath) options.dbPath = dbPath;

  const run = await startSidecar(options);
  console.log(`live-recorder backend (${run.instance.baseUrl}) ready: instance=${run.instance.instanceId} pid=${run.instance.pid}`);
  installShutdownSignals(run);
  // 宿主（Tauri 进程）强退/崩溃兜底：父进程消失即自检退出，避免孤儿后端常驻。
  watchParentExit(run.close);
}

main().catch((err) => {
  console.error('failed to start backend', err);
  process.exit(1);
});
