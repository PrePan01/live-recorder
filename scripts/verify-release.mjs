#!/usr/bin/env node
// 在本地复现 release.yml 的 build job，避免提交后才发现验证阶段失败。
// 用法：node scripts/verify-release.mjs

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

function run(label, command, args, cwd = root) {
  console.log(`\n[verify-release] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status ?? 'unknown'}`;
    throw new Error(`${label} failed: ${reason}`);
  }
}

try {
  run('Install backend dependencies', npm, ['--prefix', 'backend', 'ci']);
  run('Install frontend dependencies', npm, ['--prefix', 'frontend', 'ci']);
  run('Verify backend', npm, ['--prefix', 'backend', 'test']);
  run('Verify frontend', npm, ['--prefix', 'frontend', 'test']);
  run('Build installer', npm, ['run', 'package']);
  run(
    'Verify native service lifecycle',
    'cargo',
    ['test', '--manifest-path', path.join(root, 'frontend', 'src-tauri', 'Cargo.toml'), '--lib'],
  );
  run('Verify installation payload', 'node', [path.join(root, 'scripts', 'check-installation.mjs')]);
  console.log('\n[verify-release] All release checks passed.');
} catch (error) {
  console.error(`\n[verify-release] ${error.message}`);
  process.exitCode = 1;
}
