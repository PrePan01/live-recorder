#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { repositoryRoot as root, npmCommand as npm } from './project-utils.mjs';

const run = (command, args) => {
  console.log(`[quality] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `Quality check failed (${result.status})`);
};
try {
  // 先检查版本一致性；发布说明仅在目标为 release 的 PR 中预检。
  run(process.execPath, ['scripts/check-release-version.mjs']);
  // 签名测试需要先安装前端依赖中的 Tauri CLI。
  for (const project of ['backend', 'frontend']) run(npm, ['--prefix', project, 'ci', '--include=dev']);
  // 显式列出测试文件，避免不同系统的通配符行为不一致。
  run(process.execPath, ['--test', ...readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `scripts/${name}`)]);
  run(npm, ['--prefix', 'backend', 'run', 'build']);
  run(npm, ['--prefix', 'backend', 'test']);
  run(npm, ['--prefix', 'frontend', 'run', 'lint']);
  // 本地完整验证会在打包时构建前端，此处跳过重复构建。
  if (!process.argv.includes('--build-in-installer')) run(npm, ['--prefix', 'frontend', 'run', 'build']);
  run(npm, ['--prefix', 'frontend', 'test']);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
