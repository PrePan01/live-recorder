// 在独立目录中验证版本同步，避免修改真实仓库的版本文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const manifests = ['package.json', 'backend/package.json', 'frontend/package.json', 'frontend/src-tauri/tauri.conf.json'];
const locks = ['package-lock.json', 'backend/package-lock.json', 'frontend/package-lock.json'];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lr version 中文 '));
  const write = (name, value) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  for (const name of manifests) write(name, JSON.stringify({ version: '1.2.3', preserved: true }));
  for (const name of locks) write(name, JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' }, 'node_modules/dependency': { version: '9.8.7' } } }));
  write('frontend/src-tauri/Cargo.toml', '[package]\nname = "app"\nversion = "1.2.3"\n');
  write('frontend/src-tauri/Cargo.lock', '[[package]]\nname = "app"\nversion = "1.2.3"\n\n[[package]]\nname = "dependency"\nversion = "9.8.7"\n');
  write('backend/src/api/routes/service.ts', "export const health = { version: '1.2.3', ready: true };\n");
  write('backend/src/sidecar/types.ts', "export const APP_VERSION = '1.2.3';\n");
  mkdirSync(join(root, 'scripts'));
  for (const name of ['project-utils.mjs', 'version-set.mjs', 'check-release-version.mjs'])
    copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name));
  return {
    root,
    read: name => readFileSync(join(root, name), 'utf8'),
    run: (name, ...args) => spawnSync(process.execPath, [join(root, 'scripts', name), ...args], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 10000,
    }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const version of ['2.3.4', '2.3.4-beta.1']) {
  test(`版本同步覆盖所有清单、锁文件和运行时，并支持重复执行：${version}`, () => {
    const f = fixture();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.run('version-set.mjs', version);
        assert.equal(result.status, 0, result.stderr);
        for (const name of manifests) assert.deepEqual(JSON.parse(f.read(name)), { version, preserved: true });
        for (const name of locks) {
          const lock = JSON.parse(f.read(name));
          assert.equal(lock.version, version);
          assert.equal(lock.packages[''].version, version);
          assert.equal(lock.packages['node_modules/dependency'].version, '9.8.7');
        }
        assert(f.read('frontend/src-tauri/Cargo.toml').includes(`version = "${version}"`));
        const cargoLock = f.read('frontend/src-tauri/Cargo.lock');
        assert(cargoLock.includes(`name = "app"\nversion = "${version}"`));
        assert(cargoLock.includes('name = "dependency"\nversion = "9.8.7"'));
        assert.equal(f.read('backend/src/api/routes/service.ts'), `export const health = { version: '${version}', ready: true };\n`);
        assert.equal(f.read('backend/src/sidecar/types.ts'), `export const APP_VERSION = '${version}';\n`);
        const checked = f.run('check-release-version.mjs');
        assert.equal(checked.status, 0, checked.stderr);
        assert.equal(checked.stdout, version);
      }
    } finally { f.close(); }
  });
}

test('无效版本不会写入文件；清单版本不一致仍会阻止发布', () => {
  const f = fixture();
  try {
    const files = [...manifests, ...locks, 'frontend/src-tauri/Cargo.toml', 'frontend/src-tauri/Cargo.lock', 'backend/src/api/routes/service.ts', 'backend/src/sidecar/types.ts'];
    const before = files.map(f.read);
    assert.equal(f.run('version-set.mjs', 'invalid').status, 1);
    assert.deepEqual(files.map(f.read), before);
    writeFileSync(join(f.root, 'frontend/package.json'), '{"version":"1.2.4"}');
    const result = f.run('check-release-version.mjs');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /frontend\/package\.json: 1\.2\.4/);
  } finally { f.close(); }
});
