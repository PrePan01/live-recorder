#!/usr/bin/env node
// 同步清单、锁文件和后端运行时版本，再校验版本一致性。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot as root, readProjectJson, JSON_VERSION_FILES } from './project-utils.mjs';
import { spawnSync } from 'node:child_process';

const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`用法: npm run version:set <semver>（如 npm run version:set 0.5.82）`);
  process.exit(1);
}

function setJsonVersion(rel, version) {
  const file = join(root, rel);
  const json = readProjectJson(rel);
  if (json.version === undefined) throw new Error(`${rel} 无 version 字段`);
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ✓ ${rel} → ${version}`);
}

function setCargoToml(rel, version) {
  const file = join(root, rel);
  let text = readFileSync(file, 'utf8');
  text = text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  writeFileSync(file, text);
  console.log(`  ✓ ${rel} → ${version}`);
}

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
      // 重复设置相同版本不算失败。
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
  for (const file of JSON_VERSION_FILES) setJsonVersion(file, next);
  setCargoToml('frontend/src-tauri/Cargo.toml', next);
  setJsonVersion('package-lock.json', next);
  setJsonVersion('backend/package-lock.json', next);
  setJsonVersion('frontend/package-lock.json', next);
  setCargoLock('frontend/src-tauri/Cargo.lock', next);
  setBackendRuntimeVersion(next);

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