import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function sqliteTarget({ platform = process.platform, arch = process.arch, musl = false } = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch))
    throw new Error(`Unsupported packaged SQLite target: ${platform}/${arch}`);
  return `${platform === 'linux' && musl ? 'linuxmusl' : platform}-${arch}.node`;
}

// Only known development artifacts are removed. Runtime JS, data, licenses and
// native libraries remain intact; dependency pruning never touches the checkout.
function trimMetadata(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (['test', 'tests', '__tests__'].includes(entry.name)) rmSync(file, { recursive: true });
      else trimMetadata(file);
    } else if (/\.d\.(?:ts|mts|cts)(?:\.map)?$|\.(?:js|mjs|cjs)\.map$/.test(entry.name)) {
      rmSync(file);
    }
  }
}

export function pruneBackendPayload(directory, target = {}) {
  const modules = join(directory, 'node_modules');
  const sqlite = join(modules, 'better-sqlite3');
  const selected = sqliteTarget(target);
  const version = JSON.parse(readFileSync(join(sqlite, 'package.json'), 'utf8')).version;
  // Fail closed when an upstream layout changes instead of silently dropping a
  // new runtime dependency or falling back to a binary for the wrong CPU.
  if (version !== '13.0.3' || !existsSync(join(sqlite, 'prebuilds', selected)))
    throw new Error(`Missing supported SQLite prebuild: ${version}/${selected}`);
  const youtube = join(modules, 'youtubei.js');
  if (!existsSync(join(youtube, 'dist/src/platform/node.js')))
    throw new Error('youtubei.js Node entrypoint missing');

  for (const name of readdirSync(join(sqlite, 'prebuilds'))) {
    if (name !== selected) rmSync(join(sqlite, 'prebuilds', name), { recursive: true, force: true });
  }
  for (const name of ['src', 'deps', 'build', 'binding.gyp'])
    rmSync(join(sqlite, name), { recursive: true, force: true });
  // Keep nested dependency metadata/licenses; remove only the native build headers.
  for (const name of ['node-addon-api']) {
    const headers = join(sqlite, 'node_modules', name);
    if (existsSync(headers)) {
      for (const entry of readdirSync(headers)) {
        if (!/^(?:LICENSE|COPYING|NOTICE|package\.json)/i.test(entry))
          rmSync(join(headers, entry), { recursive: true, force: true });
      }
    }
  }
  // The application imports the Node export, never the browser/worker/RN bundles.
  rmSync(join(youtube, 'bundle'), { recursive: true, force: true });
  trimMetadata(modules);
  // Keep installer metadata/licenses and remove only the duplicate executables.
  // The one executable used at runtime lives in Resources/ffmpeg.
  function removeMediaCopies(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) removeMediaCopies(file);
      else if (/^(?:ffmpeg|ffprobe)(?:\.exe)?$/.test(entry.name)) rmSync(file);
    }
  }
  for (const scope of ['@ffmpeg-installer', '@ffprobe-installer']) removeMediaCopies(join(modules, scope));
}

export function stageBackend(source, destination, target = {}) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of ['dist', 'scripts', 'node_modules', 'package.json', 'package-lock.json'])
    cpSync(join(source, name), join(destination, name), { recursive: true, verbatimSymlinks: true });
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'prune', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
  ], { cwd: destination, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot stage production dependencies: ${result.error ?? result.status}`);
  rmSync(join(destination, 'package-lock.json'));
  pruneBackendPayload(destination, target);
}
