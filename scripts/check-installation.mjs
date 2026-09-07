// Validate the payload users actually install, including bundled Node and native modules.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const release = path.join(root, 'release');
const expected = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;
let temporary;
function run(command, args, timeout = 60000) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    timeout,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `installation check failed: ${command} (${result.error ?? result.signal ?? result.status})`,
    );
}
function findResources(directory) {
  if (
    existsSync(path.join(directory, 'node.exe')) &&
    existsSync(path.join(directory, 'backend/package.json'))
  )
    return directory;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findResources(path.join(directory, entry.name));
      if (found) return found;
    }
  }
}
try {
  let resources;
  if (process.platform === 'win32') {
    temporary = mkdtempSync(path.join(tmpdir(), 'lr-msi-verify-'));
    const msi = readdirSync(release).find(
      (name) => name.includes(`_${expected}_`) && name.endsWith('.msi'),
    );
    if (!msi) throw new Error('Windows installer missing');
    run(
      'msiexec.exe',
      ['/a', path.join(release, msi), '/qn', `TARGETDIR=${temporary}`],
      120000,
    );
    resources = findResources(temporary);
  } else if (process.platform === 'darwin') {
    resources = path.join(
      release,
      'Live Recorder.app',
      'Contents',
      'Resources',
    );
  } else {
    throw new Error('installation validation supports macOS and Windows');
  }
  if (!resources) throw new Error('bundled Node/backend layout is invalid');
  const backend = path.join(resources, 'backend');
  const node = path.join(
    resources,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const version = JSON.parse(
    readFileSync(path.join(backend, 'package.json'), 'utf8'),
  ).version;
  if (version !== expected)
    throw new Error(`stale bundled backend: ${version}, expected ${expected}`);
  run(node, [
    '--expose-gc',
    path.join(backend, 'scripts/check-runtime.mjs'),
    backend,
  ]);
  run(node, [path.join(backend, 'scripts/check-startup.mjs'), backend]);
  console.log(
    `installation payload verified: ${expected}, ${process.platform}/${process.arch}`,
  );
} finally {
  if (temporary)
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
