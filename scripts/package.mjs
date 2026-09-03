#!/usr/bin/env node
// 统一打包入口（PrePan：macOS/Windows 均一行命令，产物只放根目录 release/）：
//   1) 后端构建 backend/dist
//   2) tauri build（按当前平台产出 macOS .app / Windows .msi/.exe）
//   3) macOS 额外用 hdiutil 生成 .dmg
//   4) 把产物拷贝到根目录 release/（先清理旧产物）
//   5) 清理 tauri target bundle 中间产物（不在其他位置留产物）
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const bundle = path.join(root, 'frontend', 'src-tauri', 'target', 'release', 'bundle');
const release = path.join(root, 'release');

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`[package] 命令失败: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

// 1) 后端构建
console.log('[package] 1/4 构建后端 dist…');
run('npm', ['run', 'build'], path.join(root, 'backend'));

// 1.5) 打包前把后端 node_modules 精简为仅生产依赖（dev 依赖 typescript/vitest 等占 ~90MB，运行不需要）
//      打包完成后再恢复完整依赖，避免影响开发环境。
const backendDir = path.join(root, 'backend');
console.log('[package] 精简后端 node_modules 为生产依赖…');
run('npm', ['prune', '--omit=dev'], backendDir);

// 2) tauri build（含前端 vite build + bundle-resources；后端已在步骤 1 构建并精简，跳过 bundle-resources 内重建）
console.log('[package] 2/4 tauri build…');
process.env.LR_SKIP_BACKEND_BUILD = '1';
run(isWin ? 'npx.cmd' : 'npx', ['tauri', 'build'], path.join(root, 'frontend'));

// 3) macOS dmg
if (!isWin) {
  console.log('[package] 3/4 生成 dmg…');
  // 清掉旧 dmg，避免 bundle/dmg 残留旧版本被一并拷贝。
  const dmgDir = path.join(bundle, 'dmg');
  if (existsSync(dmgDir)) {
    for (const f of readdirSync(dmgDir)) if (/\.dmg$/i.test(f)) rmSync(path.join(dmgDir, f), { force: true });
  }
  run('node', ['scripts/bundle-dmg.mjs'], path.join(root, 'frontend'));
}

// 4) 拷贝产物到 release/
mkdirSync(release, { recursive: true });
// 清理旧产物（含 .DS_Store）
for (const f of readdirSync(release)) {
  if (/\.(dmg|exe|msi)$/.test(f) || f === 'Live Recorder.app' || f === '.DS_Store' || /^Live Recorder/.test(f)) {
    rmSync(path.join(release, f), { recursive: true, force: true });
  }
}
const products = [];
if (!isWin) {
  const macosDir = path.join(bundle, 'macos');
  if (existsSync(macosDir)) {
    for (const f of readdirSync(macosDir)) {
      if (f === '.DS_Store') continue;
      cpSync(path.join(macosDir, f), path.join(release, f), { recursive: true });
      products.push(f);
    }
  }
  const dmgDir = path.join(bundle, 'dmg');
  if (existsSync(dmgDir)) {
    for (const f of readdirSync(dmgDir)) {
      if (/\.dmg$/i.test(f)) {
        copyFileSync(path.join(dmgDir, f), path.join(release, f));
        products.push(f);
      }
    }
  }
} else {
  for (const sub of ['msi', 'nsis']) {
    const dir = path.join(bundle, sub);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        copyFileSync(path.join(dir, f), path.join(release, f));
        products.push(f);
      }
    }
  }
}

// 5) 清理 tauri target bundle 中间产物（只保留 release/）
rmSync(bundle, { recursive: true, force: true });

// 6) 恢复后端完整依赖（含 dev 依赖），避免影响开发/测试环境。
console.log('[package] 恢复后端完整依赖（npm ci）…');
try {
  run('npm', ['ci'], backendDir);
} catch {
  console.warn('[package] 恢复 npm ci 失败，如需开发请手动 cd backend && npm ci');
}

console.log(`[package] 完成 ✅ 产物已输出到 release/: ${products.join(', ')}`);