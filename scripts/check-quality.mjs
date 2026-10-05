#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args) => {
  console.log(`[quality] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `Quality check failed (${result.status})`);
};
try {
  // Signature integration tests use the pinned Tauri CLI installed below.
  for (const project of ['backend', 'frontend']) run(npm, ['--prefix', project, 'ci', '--include=dev']);
  // Expand explicitly so Windows and Unix run the same release test suite.
  run(process.execPath, ['--test', ...readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `scripts/${name}`)]);
  run(npm, ['--prefix', 'backend', 'run', 'build']);
  run(npm, ['--prefix', 'backend', 'test']);
  run(npm, ['--prefix', 'frontend', 'run', 'lint']);
  // Local verification builds the frontend as part of the installer instead.
  if (!process.argv.includes('--build-in-installer')) run(npm, ['--prefix', 'frontend', 'run', 'build']);
  run(npm, ['--prefix', 'frontend', 'test']);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
