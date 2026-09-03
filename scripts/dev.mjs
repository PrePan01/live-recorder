// 一键启动脚本：单一 LIVE_RECORDER_MODE=fake|real 控制前后端。
// real（默认）= 真实平台适配器 + 前端直连（行为与正式环境一致，仅数据隔离，PrePan #223）；
// fake = 后端 fake 适配器（仅显式 `npm run dev:fake` / `npm run dev fake` 时启用，用于快速冒烟）。
// 前端已无自建 mock（v1.3 收口清理），两端统一直连后端。
// 用法：npm run dev（real 默认）/ npm run dev:fake（fake 显式）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? process.env.LIVE_RECORDER_MODE ?? 'real';
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

// 开发环境数据隔离（PrePan #219）：dev 后端使用仓库本地 .dev-data 作为独立数据目录
// （DB/state/实例锁/ready 全部隔离），并改用独立端口 43140（避开正式客户端候选端口
// 43120-43130 的探测范围——否则正式客户端可能误接管 dev 后端，P0 隔离缺陷），
// 避免与本地安装的正式客户端共享数据或端口冲突。dev 后端改写的房间/设置/录制记录等不会影响正式客户端。
const devDataDir = path.join(root, '.dev-data');
const devPort = process.env.LIVE_RECORDER_PORT ?? '43140';
const devApiBase = `http://127.0.0.1:${devPort}/api/v1`;

console.log(`live-recorder dev（mode=${mode}）：后端 RECORDING_ADAPTER=${mode}，数据目录=${devDataDir}，端口=${devPort}，前端直连后端`);
start('backend', 'npm', ['run', 'dev'], 'backend', {
  LIVE_RECORDER_DATA_DIR: devDataDir,
  LIVE_RECORDER_PORT: devPort,
});
start('frontend', 'npm', ['run', 'dev'], 'frontend', {
  VITE_USE_MOCK: '0',
  VITE_API_BASE: devApiBase,
  LIVE_RECORDER_PORT: devPort,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
}