// 停止残留的 dev 会话（dev.mjs / tsx watch 后端 / vite 前端），并清理 .dev-data 陈旧锁。
// 用途：端口冲突或想干净重启时先执行 `npm run dev:stop`，再 `npm run dev`。
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = ['scripts/dev.mjs', 'tsx watch src/index.ts', 'frontend/node_modules/.bin/vite', 'frontend/node_modules/vite/bin/vite.js'];

for (const pattern of PATTERNS) {
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch {
    // pkill 无匹配返回非 0，忽略
  }
}
console.log('已停止残留 dev 进程（dev.mjs/tsx watch/vite）。');

// 清理陈旧锁/ready（若后端进程已死，锁会被后端启动时自动按过期处理；这里兜底清理避免残留）。
try {
  await rm(path.join(root, '.dev-data', 'state', 'instance.lock'), { force: true });
  await rm(path.join(root, '.dev-data', 'state', 'ready.json'), { force: true });
} catch {
  // 忽略
}
console.log('已清理 .dev-data 陈旧锁/ready。现在可重新执行 npm run dev。');
