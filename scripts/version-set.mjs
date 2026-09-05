#!/usr/bin/env node
// 一键改版本：npm run version:set <新版本> —— 同步全部 manifest（含 lockfile），
// 并跑 check-release-version 校验一致。用法：npm run version:set 0.5.82
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`用法: npm run version:set <semver>（如 npm run version:set 0.5.82）`);
  process.exit(1);
}

/** 更新 JSON 文件的顶层 version 字段。 */
function setJsonVersion(rel, version) {
  const file = join(root, rel);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.version === undefined) throw new Error(`${rel} 无 version 字段`);
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ✓ ${rel} → ${version}`);
}

/** 更新 Cargo.toml 首行 version。 */
function setCargoToml(rel, version) {
  const file = join(root, rel);
  let text = readFileSync(file, 'utf8');
  text = text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  writeFileSync(file, text);
  console.log(`  ✓ ${rel} → ${version}`);
}

/** 更新 Cargo.lock 中 [[package]] name="app" 的 version（应用 bin crate）。 */
function setCargoLock(rel, version) {
  const file = join(root, rel);
  let text = readFileSync(file, 'utf8');
  const re = /(\[\[package\]\]\r?\nname = "app"\r?\n)version = "[^"]+"/;
  if (!re.test(text)) {
    console.warn(`  ! ${rel} 未找到 name="app" 的 package 段，跳过（可后续 cargo update 同步）`);
    return;
  }
  text = text.replace(re, `$1version = "${version}"`);
  writeFileSync(file, text);
  console.log(`  ✓ ${rel} (app) → ${version}`);
}

/** 更新后端运行时版本来源（health 接口 / APP_VERSION），避免发版后 health 版本滞后。 */
function setBackendRuntimeVersion(version) {
  const files = [
    ['backend/src/api/routes/service.ts', /version: '[^']+',/, `version: '${version}',`],
    ['backend/src/sidecar/types.ts', /APP_VERSION = '[^']+'/, `APP_VERSION = '${version}'`],
  ];
  for (const [rel, pattern, replacement] of files) {
    const file = join(root, rel);
    const text = readFileSync(file, 'utf8');
    const next = text.replace(pattern, replacement);
    if (next === text) {
      // 幂等运行（目标版本=当前值）：replace 无变化，非错误，明确提示已是最新。
      if (text.includes(`'${version}'`)) {
        console.log(`  = ${rel} 已是最新版本（${version}）`);
      } else {
        console.warn(`  ! ${rel} 未匹配到版本位，跳过`);
      }
      continue;
    }
    writeFileSync(file, next);
    console.log(`  ✓ ${rel} → ${version}`);
  }
}

console.log(`[version:set] ${next}`);
try {
  // 核心 manifest（check-release-version 校验）
  setJsonVersion('package.json', next);
  setJsonVersion('backend/package.json', next);
  setJsonVersion('frontend/package.json', next);
  setJsonVersion('frontend/src-tauri/tauri.conf.json', next);
  setCargoToml('frontend/src-tauri/Cargo.toml', next);
  // lockfile（与核心配套，避免 stale diff）
  setJsonVersion('package-lock.json', next);
  setJsonVersion('backend/package-lock.json', next);
  setJsonVersion('frontend/package-lock.json', next);
  setCargoLock('frontend/src-tauri/Cargo.lock', next);
  // 后端运行时版本（health / APP_VERSION），避免发版后 health 版本滞后
  setBackendRuntimeVersion(next);

  // 校验
  const check = spawnSync('node', ['scripts/check-release-version.mjs'], { cwd: root, stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('[version:set] check-release-version 校验未通过');
    process.exit(check.status ?? 1);
  }
  console.log('[version:set] 完成 ✅ 全部 manifest 已同步，校验通过');
} catch (err) {
  console.error(`[version:set] 失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}