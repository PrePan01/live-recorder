// 一键启动 Tauri 桌面端开发环境：先构建供 Rust 壳拉起的后端 dist，
// 再启动 Tauri + Vite。默认使用与正式客户端隔离的开发数据和端口。
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const devDataDir = process.env.LIVE_RECORDER_DATA_DIR ?? path.join(root, '.dev-data');
const devPort = process.env.LIVE_RECORDER_PORT ?? '43140';
const adapter = process.env.RECORDING_ADAPTER ?? 'real';
const env = {
  ...process.env,
  LIVE_RECORDER_DATA_DIR: devDataDir,
  LIVE_RECORDER_PORT: devPort,
  RECORDING_ADAPTER: adapter,
};

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${npm} ${args.join(' ')} ${signal ? `被 ${signal} 中断` : `退出，code=${code}`}`));
    });
  });
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

console.log(`Tauri dev：后端=${adapter}，数据目录=${devDataDir}，端口=${devPort}`);
const occupiedPorts = (await Promise.all([devPort, '5173'].map(async (port) => (
  (await isPortInUse(Number(port))) ? port : null
)))).filter(Boolean);
if (occupiedPorts.length > 0) {
  console.log(`检测到开发端口被占用（${occupiedPorts.join(', ')}），正在执行 npm run dev:stop…`);
  await run(['run', 'dev:stop'], root);
}
await run(['run', 'build'], path.join(root, 'backend'));
await run(['run', 'tauri:dev'], path.join(root, 'frontend'));
