#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot as root, readProjectJson, JSON_VERSION_FILES } from './project-utils.mjs';

const versions = new Map(JSON_VERSION_FILES.map(file => [file, readProjectJson(file).version]));

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
