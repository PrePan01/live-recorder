// Run with the exact Node binary shipped in the installer, not merely the build host.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
console.log(
  `runtime smoke passed: Node ${process.version}, SQLite addon ${require('better-sqlite3/package.json').version}, ${process.platform}/${process.arch}`,
);
