import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const notesStep = ci.jobs.test.steps.find(step => step.name === 'Verify release PR notes');

function qualityFixture({ frontendVersion = '1.5.3', notes = false, releasePr = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lr-quality-preflight-'));
  for (const directory of ['scripts', 'backend', 'frontend/src-tauri']) mkdirSync(join(root, directory), { recursive: true });
  for (const name of ['project-utils.mjs', 'check-quality.mjs', 'check-release-version.mjs', 'check-release-notes.mjs', 'generate-update-manifest.mjs', 'verify-installer-signatures.mjs'])
    copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  for (const path of ['package.json', 'backend/package.json']) writeFileSync(join(root, path), JSON.stringify({ version: '1.5.3' }));
  writeFileSync(join(root, 'frontend/package.json'), JSON.stringify({ version: frontendVersion }));
  writeFileSync(join(root, 'frontend/src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.5.3', plugins: { updater: { pubkey: 'unused' } } }));
  writeFileSync(join(root, 'frontend/src-tauri/Cargo.toml'), 'version = "1.5.3"\n');
  writeFileSync(join(root, 'release-notes.json'), JSON.stringify({ releases: notes ? [{ version: '1.5.3', publishedAt: '2026-10-01', notes: ['Fix'] }] : [] }));
  try {
    if (releasePr) {
      return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', notesStep.run], {
        cwd: root, encoding: 'utf8', timeout: 10000,
      });
    }
    // 禁用 npm，确认元数据检查通过后才会进入依赖安装，且不访问网络。
    return spawnSync(process.execPath, ['scripts/check-quality.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 10000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('release PR rejects missing release notes before installing any dependencies', () => {
  const result = qualityFixture({ releasePr: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing release notes for 1\.5\.3/);
  assert(!result.stdout.includes('npm --prefix'));
});

test('release PR accepts matching notes and rejects inconsistent manifest versions', () => {
  const valid = qualityFixture({ releasePr: true, notes: true });
  assert.equal(valid.status, 0, valid.stderr);
  const invalid = qualityFixture({ releasePr: true, notes: true, frontendVersion: '1.5.4' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Expected every manifest to use version 1\.5\.3/);
});

test('shared quality still rejects inconsistent manifest versions', () => {
  const result = qualityFixture({ frontendVersion: '1.5.4', notes: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected every manifest to use version 1\.5\.3/);
  assert(!result.stdout.includes('npm --prefix'));
});

test('main PR and post-merge quality do not require release notes', () => {
  for (const notes of [false, true]) {
    const result = qualityFixture({ notes });
    assert.equal(result.status, 1); // npm 被禁用，预检本身已通过。
    assert.match(result.stdout, /npm --prefix backend ci --include=dev/);
    assert.match(result.stderr, /npm.*ENOENT/);
    assert(!result.stdout.includes('scripts/check-release-notes.mjs'));
    assert(!result.stderr.includes('Missing release notes'));
  }
});
