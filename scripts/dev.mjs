// 启动前后端开发服务，默认连接真实平台；dev:fake 使用模拟适配器。
import { spawn } from "node:child_process";
import path from "node:path";
import { repositoryRoot as root } from './project-utils.mjs';

const mode = process.argv[2] ?? process.env.LIVE_RECORDER_MODE ?? "real";

if (!["fake", "real"].includes(mode)) {
  console.error(`未知模式: ${mode}（支持 fake / real）`);
  process.exit(1);
}

const children = [];

function start(name, cmd, args, cwd, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: path.join(root, cwd),
    env: { ...process.env, RECORDING_ADAPTER: mode, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    console.log(`[${name}] 退出，code=${code}`);
    process.exit(code ?? 0);
  });
  children.push(child);
}

// 开发数据独立存放，默认端口避开正式客户端的 43120–43130，防止误连。
const devDataDir = path.join(root, ".dev-data");
const devPort = process.env.LIVE_RECORDER_PORT ?? "43140";
const devApiBase = `http://127.0.0.1:${devPort}/api/v1`;

// 已有开发服务占用端口时直接报错，避免只启动前端。
async function preflightPort() {
  try {
    const res = await fetch(`${devApiBase}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      console.error(
        `\n[错误] dev 端口 ${devPort} 已被一个正在运行的 live-recorder dev 实例占用。`,
      );
      console.error(
        `处置：①若这就是你要用的会话，直接访问 http://localhost:5173；`,
      );
      console.error(
        `②若要干净重启，先执行 npm run dev:stop 停掉旧会话，再 npm run dev。\n`,
      );
      process.exit(1);
    }
  } catch {
    // 健康检查未响应时，继续尝试启动。
  }
}

console.log(
  `live-recorder dev（mode=${mode}）：后端 RECORDING_ADAPTER=${mode}，数据目录=${devDataDir}，端口=${devPort}，前端直连后端`,
);
await preflightPort();
start("backend", "npm", ["run", "dev"], "backend", {
  LIVE_RECORDER_DATA_DIR: devDataDir,
  LIVE_RECORDER_PORT: devPort,
  LIVE_RECORDER_DEVELOPMENT: "1",
});
start("frontend", "npm", ["run", "dev"], "frontend", {
  VITE_USE_MOCK: "0",
  VITE_API_BASE: devApiBase,
  LIVE_RECORDER_PORT: devPort,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of children) c.kill();
    process.exit(0);
  });
}
