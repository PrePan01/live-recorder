#!/usr/bin/env node
// 打包前准备 Tauri bundle 资源：把可用的 node 运行时复制到 src-tauri/.bundle/node，
// 供 tauri.conf.json 的 resources 打进安装包（GUI 双击启动 PATH 精简，系统常无 node）。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'src-tauri', '.bundle');
const isWin = process.platform === 'win32';
const dest = join(destDir, isWin ? 'node.exe' : 'node');

const candidates = [
  process.env.LR_NODE_PATH,
  process.execPath,
  // Windows 常见安装路径
  ...(isWin
    ? [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe'),
        join(process.env.ProgramW6432 ?? '', 'nodejs', 'node.exe'),
      ]
    : []),
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

// Windows 打包不需要 dmg/hdiutil 清理。
if (isWin) {
  console.log('[bundle-resources] Windows 平台跳过 dmg 残留清理');
  process.exit(0);
}

// 清理 Tauri DMG 打包的残留状态（bundle_dmg.sh 偶发失败主因）：
// 1) 上一次中断/失败遗留的 rw.* 临时镜像（hdiutil create 的 UDRW 中间文件）
// 2) 残留的挂载点（/Volumes/Live Recorder*）与磁盘（hdiutil attach 后未 detach）
// 在每次 beforeBundle 前执行，保证每次 tauri build 的 dmg 步骤从干净状态开始。
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dmgDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
try {
  if (existsSync(dmgDir)) {
    const stale = readdirSync(dmgDir).filter((f) => /^rw\./.test(f));
    for (const f of stale) {
      try {
        rmSync(join(dmgDir, f), { force: true });
        console.log(`[bundle-resources] 清理残留 dmg 临时文件 ${f}`);
      } catch {
        /* 忽略单文件删除失败 */
      }
    }
  }
} catch {
  /* dmg 目录不存在则无需清理 */
}

try {
  const { stdout } = spawnSync('hdiutil', ['info'], { encoding: 'utf8' });
  if (stdout) {
    // 卸载残留的 Live Recorder 挂载点（幂等：已挂载才卸载，未挂载静默跳过）
    const mounts = stdout.split('\n').filter((l) => l.includes('/Volumes/Live Recorder'));
    for (const m of mounts) {
      const mountPoint = m.trim().split(/\s+/).pop();
      if (mountPoint) {
        spawnSync('hdiutil', ['detach', mountPoint, '-force'], { encoding: 'utf8' });
        console.log(`[bundle-resources] 卸载残留挂载 ${mountPoint}`);
      }
    }
  }
} catch {
  /* hdiutil 不可用时忽略 */
}