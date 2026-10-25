// Run with the exact Node binary shipped in the installer, not merely the build host.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { buildServices } = await import(
  pathToFileURL(path.join(root, 'dist/core/services.js'))
);
const { buildApp } = await import(
  pathToFileURL(path.join(root, 'dist/api/server.js'))
);
for (let round = 0; round < 5; round++) {
  const services = buildServices({ dbPath: ':memory:', mode: 'fake' });
  // Migrations / query preparation + route schema compilation trigger the native
  // ObjectWrap GC crash seen in Node 24.20 with the old V8-based SQLite addon.
  for (let i = 0; i < 2000; i++) services.db.prepare('SELECT 1 AS ok').get();
  const { app } = buildApp(services);
  await app.ready();
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers: { host: '127.0.0.1:43120' },
  });
  if (response.statusCode !== 200)
    throw new Error(`health returned ${response.statusCode}`);
  await app.close();
  global.gc?.();
}
require('keytar');
if (process.argv.includes('--packaged')) {
  // Exercise the trimmed dependency tree with the bundled Node. These checks run
  // during packaging/installation validation, never in normal application boot.
  const youtube = await import(pathToFileURL(require.resolve('youtubei.js')));
  assert.equal(typeof youtube.Innertube.create, 'function');
  assert.equal(typeof require('nodemailer').createTransport, 'function');
  assert.equal(typeof require('ws').WebSocket, 'function');
  const { resolveBin } = await import(pathToFileURL(path.join(root, 'dist/utils/ffmpeg.js')));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    for (const name of ['ffmpeg', 'ffprobe']) {
      const binary = resolveBin(name);
      assert.equal(path.dirname(binary), path.join(path.dirname(process.execPath), 'ffmpeg'));
      assert.match(execFileSync(binary, ['-version'], { encoding: 'utf8', timeout: 10000 }), new RegExp(`^${name} version`));
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
}
console.log(
  `runtime smoke passed: Node ${process.version}, SQLite addon ${require('better-sqlite3/package.json').version}, ${process.platform}/${process.arch}`,
);
