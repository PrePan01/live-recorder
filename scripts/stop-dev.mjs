// 停止开发进程，并清理开发目录中的实例锁和就绪标记。
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot as root } from './project-utils.mjs';

const PATTERNS = ['scripts/dev.mjs', 'tsx watch src/index.ts', 'frontend/node_modules/.bin/vite', 'frontend/node_modules/vite/bin/vite.js'];

for (const pattern of PATTERNS) {
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  } catch {
    // 没有匹配进程时，pkill 也会返回非零。
  }
}
console.log('已停止残留 dev 进程（dev.mjs/tsx watch/vite）。');

try {
  await rm(path.join(root, '.dev-data', 'state', 'instance.lock'), { force: true });
  await rm(path.join(root, '.dev-data', 'state', 'ready.json'), { force: true });
} catch {
  // 清理失败不影响后续启动时的过期锁检查。
}
console.log('已清理 .dev-data 陈旧锁/ready。现在可重新执行 npm run dev。');
