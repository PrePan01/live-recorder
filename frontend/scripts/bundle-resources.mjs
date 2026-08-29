#!/usr/bin/env node
// 打包前准备 Tauri bundle 资源：把可用的 node 运行时复制到 src-tauri/.bundle/node，
// 供 tauri.conf.json 的 resources 打进安装包（GUI 双击启动 PATH 精简，系统常无 node）。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'src-tauri', '.bundle');
const dest = join(destDir, 'node');

const candidates = [
  process.env.LR_NODE_PATH,
  process.execPath,
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
  join(process.env.HOME ?? '', '.local', 'bin', 'node'),
];
// nvm 最高版本
try {
  const nvmDir = join(process.env.HOME ?? '', '.nvm', 'versions', 'node');
  const { readdirSync } = await import('node:fs');
  if (existsSync(nvmDir)) {
    const versions = readdirSync(nvmDir).filter((v) => existsSync(join(nvmDir, v, 'bin', 'node'))).sort();
    if (versions.length > 0) candidates.push(join(nvmDir, versions[versions.length - 1], 'bin', 'node'));
  }
} catch {
  /* 忽略 */
}

const src = candidates.find((p) => p && existsSync(p));
if (!src) {
  console.error('[bundle-resources] 未找到 node 运行时，跳过打包 node（后端可能无法启动）');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[bundle-resources] node -> ${dest}`);