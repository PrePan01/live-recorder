#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));

const versions = new Map([
  ['package.json', readJson('package.json').version],
  ['backend/package.json', readJson('backend/package.json').version],
  ['frontend/package.json', readJson('frontend/package.json').version],
  ['frontend/src-tauri/tauri.conf.json', readJson('frontend/src-tauri/tauri.conf.json').version],
]);

const cargoToml = readFileSync(join(root, 'frontend/src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
versions.set('frontend/src-tauri/Cargo.toml', cargoVersion);

const expected = versions.get('package.json');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected ?? '')) {
  console.error(`[release-version] package.json contains an invalid version: ${expected ?? '<missing>'}`);
  process.exit(1);
}

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  console.error(`[release-version] Expected every manifest to use version ${expected}:`);
  for (const [file, version] of mismatches) {
    console.error(`  ${file}: ${version ?? '<missing>'}`);
  }
  process.exit(1);
}

process.stdout.write(expected);
