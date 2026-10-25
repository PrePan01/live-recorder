import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pruneBackendPayload, sqliteTarget, stageBackend } from '../frontend/scripts/stage-backend.mjs';
import { machoArchitectures, verifyOptimizedYoutubeRuntime } from '../frontend/scripts/optimize-youtube-runtime.mjs';
import { MACOS_RUNTIME_TREE_SHA256, runtimeFiles } from '../frontend/scripts/bundle-youtube.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
function fixture(prefix = 'lr-package-test-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const put = (name, data = 'runtime data') => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  put('node_modules/better-sqlite3/package.json', JSON.stringify({ version: '13.0.3' }));
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linuxmusl-x64'])
    put(`node_modules/better-sqlite3/prebuilds/${target}.node`, target);
  for (const name of ['deps/sqlite3/sqlite3.c', 'src/better_sqlite3.cpp', 'build/Release/better_sqlite3.node', 'binding.gyp'])
    put(`node_modules/better-sqlite3/${name}`);
  put('node_modules/better-sqlite3/lib/index.js', 'sqlite runtime');
  put('node_modules/youtubei.js/dist/src/platform/node.js', 'node runtime');
  put('node_modules/youtubei.js/dist/protos/generated.js', 'protobuf runtime');
  put('node_modules/youtubei.js/dist/src/platform/node.d.ts');
  put('node_modules/youtubei.js/bundle/browser.js');
  for (const [scope, name] of [['@ffmpeg-installer', 'ffmpeg'], ['@ffprobe-installer', 'ffprobe']]) {
    put(`node_modules/${scope}/target/${name}`);
    put(`node_modules/${scope}/target/${name}.exe`);
    put(`node_modules/${scope}/target/LICENSE`, 'keep media license');
    put(`node_modules/${scope}/${name}/index.js`, 'keep wrapper');
  }
  put('node_modules/library/data/catalog.json', '{"keep":true}');
  put('node_modules/library/index.js', 'keep runtime');
  put('node_modules/library/index.js.map');
  put('node_modules/library/schema.map', 'keep non-JS data');
  put('node_modules/library/LICENSE', 'keep license');
  put('node_modules/library/tests/unit.js');
  return { root, put, close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const target of [
  { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'x64', musl: true },
]) test(`payload keeps the correct SQLite binary for ${sqliteTarget(target)}`, () => {
  const f = fixture();
  try {
    pruneBackendPayload(f.root, target);
    const modules = path.join(f.root, 'node_modules');
    assert.deepEqual(readdirSync(path.join(modules, 'better-sqlite3/prebuilds')), [sqliteTarget(target)]);
    assert.equal(readFileSync(path.join(modules, 'better-sqlite3/prebuilds', sqliteTarget(target)), 'utf8'), sqliteTarget(target).replace('.node', ''));
    assert.equal(readFileSync(path.join(modules, 'better-sqlite3/lib/index.js'), 'utf8'), 'sqlite runtime');
    assert.equal(readFileSync(path.join(modules, 'youtubei.js/dist/protos/generated.js'), 'utf8'), 'protobuf runtime');
    assert.equal(readFileSync(path.join(modules, 'library/data/catalog.json'), 'utf8'), '{"keep":true}');
    assert.equal(readFileSync(path.join(modules, 'library/schema.map'), 'utf8'), 'keep non-JS data');
    for (const name of ['better-sqlite3/deps', 'better-sqlite3/src', 'better-sqlite3/build', 'youtubei.js/bundle', 'library/index.js.map', 'library/tests', '@ffmpeg-installer/target/ffmpeg', '@ffprobe-installer/target/ffprobe.exe'])
      assert.equal(existsSync(path.join(modules, name)), false, name);
    assert.equal(readFileSync(path.join(modules, '@ffmpeg-installer/target/LICENSE'), 'utf8'), 'keep media license');
    assert.equal(readFileSync(path.join(modules, 'library/LICENSE'), 'utf8'), 'keep license');
    pruneBackendPayload(f.root, target); // Repeat packaging is safe.
  } finally { f.close(); }
});

test('missing native target or changed dependency layout stops pruning before deleting files', () => {
  const f = fixture();
  try {
    assert.throws(() => pruneBackendPayload(f.root, { platform: 'linux', arch: 'arm64' }), /Missing supported/);
    assert.ok(existsSync(path.join(f.root, 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c')));
    f.put('node_modules/better-sqlite3/package.json', '{"version":"14.0.0"}');
    assert.throws(() => pruneBackendPayload(f.root), /Missing supported/);
    assert.throws(() => sqliteTarget({ platform: 'darwin', arch: 'ia32' }), /Unsupported/);
  } finally { f.close(); }
});

test('native staging handles spaces and Unicode without pruning the development checkout', { timeout: 30_000 }, () => {
  const f = fixture('lr package 中文 ');
  try {
    const dependencies = { 'better-sqlite3': '13.0.3', 'youtubei.js': '18.1.0' };
    f.put('package.json', JSON.stringify({ name: 'payload-fixture', version: '1.0.0', private: true, dependencies, devDependencies: { 'test-only': '1.0.0' } }));
    f.put('node_modules/youtubei.js/package.json', '{"name":"youtubei.js","version":"18.1.0"}');
    f.put('node_modules/test-only/package.json', '{"name":"test-only","version":"1.0.0"}');
    f.put('dist/index.js', 'application runtime');
    f.put('scripts/check-runtime.mjs', 'validation script');
    f.put('package-lock.json', JSON.stringify({
      name: 'payload-fixture', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'payload-fixture', version: '1.0.0', dependencies, devDependencies: { 'test-only': '1.0.0' } },
        'node_modules/better-sqlite3': { version: '13.0.3' },
        'node_modules/youtubei.js': { version: '18.1.0' },
        'node_modules/test-only': { version: '1.0.0', dev: true },
      },
    }));
    const destination = path.join(f.root, 'staged backend 中文');
    stageBackend(f.root, destination);
    assert.equal(readFileSync(path.join(destination, 'dist/index.js'), 'utf8'), 'application runtime');
    assert.deepEqual(readdirSync(path.join(destination, 'node_modules/better-sqlite3/prebuilds')), [sqliteTarget()]);
    assert.equal(existsSync(path.join(destination, 'node_modules/test-only')), false);
    assert.equal(existsSync(path.join(destination, 'package-lock.json')), false);
    assert.ok(existsSync(path.join(f.root, 'node_modules/test-only/package.json')));
    assert.ok(existsSync(path.join(f.root, 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c')));
    assert.ok(readdirSync(path.join(f.root, 'node_modules/better-sqlite3/prebuilds')).length > 1);
    // A second run starts from the untouched source, not the already pruned copy.
    stageBackend(f.root, destination);
    assert.deepEqual(readdirSync(path.join(destination, 'node_modules/better-sqlite3/prebuilds')), [sqliteTarget()]);
  } finally { f.close(); }
});

test('Mach-O inspection distinguishes ARM64, Intel and universal executables', () => {
  const thin = Buffer.alloc(8); thin.writeUInt32BE(0xcffaedfe); thin.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(machoArchitectures(thin), [0x0100000c]);
  const fat = Buffer.alloc(48); fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(machoArchitectures(fat), [0x01000007, 0x0100000c]);
  assert.throws(() => machoArchitectures(fat.subarray(0, 10)), /Invalid/);
  assert.deepEqual(machoArchitectures(Buffer.from('plain JS data')), []);
});

test('optimized runtime remains anchored to an external build receipt and target architecture', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lr-youtube-receipt-'));
  try {
    writeFileSync(path.join(root, 'binary'), 'trusted transformed binary');
    const files = await runtimeFiles(root);
    const receipt = { optimizationVersion: 1, architecture: 'arm64', sourceTreeSha256: MACOS_RUNTIME_TREE_SHA256, files, treeSha256: hash(JSON.stringify(files)) };
    assert.equal(await verifyOptimizedYoutubeRuntime(root, receipt, 'arm64'), true);
    assert.equal(await verifyOptimizedYoutubeRuntime(root, receipt, 'x64'), false);
    writeFileSync(path.join(root, 'binary'), 'modified binary');
    // Rewriting a shipped manifest cannot change the caller's trusted checkpoint.
    writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({ ...receipt, treeSha256: hash('forged') }));
    assert.equal(await verifyOptimizedYoutubeRuntime(root, receipt, 'arm64'), false);
    assert.equal(await verifyOptimizedYoutubeRuntime(root, { ...receipt, sourceTreeSha256: hash('unknown upstream') }, 'arm64'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('relative runtime links survive application staging and relocation', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lr-relative-copy-'));
  try {
    const original = path.join(root, 'original'); mkdirSync(original);
    writeFileSync(path.join(original, 'Python'), 'native library');
    symlinkSync('Python', path.join(original, 'alias'));
    const relocated = path.join(root, 'relocated');
    cpSync(original, relocated, { recursive: true, verbatimSymlinks: true });
    rmSync(original, { recursive: true });
    assert.equal(readlinkSync(path.join(relocated, 'alias')), 'Python');
    assert.equal(readFileSync(path.join(relocated, 'alias'), 'utf8'), 'native library');
    assert.equal((await runtimeFiles(relocated)).find(file => file.name === 'alias').link, 'Python');
    symlinkSync('../outside', path.join(relocated, 'escape'));
    await assert.rejects(runtimeFiles(relocated), /escapes package/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
