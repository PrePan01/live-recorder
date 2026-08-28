// 一键启动脚本：单一 LIVE_RECORDER_MODE=fake|real 控制前后端。
// fake（默认）= 后端 fake 适配器 + 前端直连；real = 真实平台适配器 + 前端直连。
// 前端已无自建 mock（v1.3 收口清理），两端统一直连后端。
// 用法：npm run dev（fake）/ npm run dev:real（real）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? process.env.LIVE_RECORDER_MODE ?? 'fake';
const real = mode === 'real';

if (!['fake', 'real'].includes(mode)) {
  console.error(`未知模式: ${mode}（支持 fake / real）`);
  process.exit(1);
}

const children = [];

function start(name, cmd, args, cwd, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: path.join(root, cwd),
    env: { ...process.env, RECORDING_ADAPTER: mode, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    console.log(`[${name}] 退出，code=${code}`);
    process.exit(code ?? 0);
  });
  children.push(child);
}

console.log(`live-recorder dev（mode=${mode}）：后端 RECORDING_ADAPTER=${mode}，前端直连后端`);
start('backend', 'npm', ['run', 'dev'], 'backend');
start('frontend', 'npm', ['run', 'dev'], 'frontend', { VITE_USE_MOCK: '0' });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
}