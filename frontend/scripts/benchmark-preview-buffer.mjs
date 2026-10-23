// Compare the installed player's I/O policy on the same observed network trace.
// Measures first demux input, not a rendered browser/WebView frame.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const input = process.argv[2];
if (!input) throw new Error('Usage: benchmark-preview-buffer.mjs <startup-benchmark.log>');
const samples = readFileSync(input, 'utf8').split('\n').filter(Boolean)
  .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const trace = samples.find(item => item.previewChunks?.length && !item.error);
if (!trace) throw new Error('No successful preview trace');
let now = 0;
const cache = new Map();
function load(file) {
  if (!path.extname(file)) file += existsSync(`${file}.ts`) ? '.ts' : '.js';
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, allowJs: true },
  }).outputText;
  const performance = { now: () => now };
  runInNewContext(code, { exports, self: { performance, navigator: { userAgent: '' } }, performance,
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : createRequire(import.meta.url)(name),
    console, ArrayBuffer, Uint8Array, setTimeout, clearTimeout });
  return exports;
}
const IOController = load(fileURLToPath(new URL('../node_modules/mpegts.js/src/io/io-controller.js', import.meta.url))).default;
const { livePreviewConfig } = load(fileURLToPath(new URL('../src/utils/livePreviewConfig.ts', import.meta.url)));
function replay(platform) {
  now = 1;
  let loader, firstInputMs = null, total = 0;
  class Loader {
    needStashBuffer = true;
    constructor() { loader = this; }
    open() {} isWorking() { return false; } destroy() {}
  }
  const io = new IOController({ url: 'ws://localhost/trace-replay' }, {
    ...livePreviewConfig(false, undefined, platform), seekType: 'range', customLoader: Loader,
  });
  io.onDataArrival = buffer => { firstInputMs ??= now; return buffer.byteLength; };
  io.open();
  for (const chunk of trace.previewChunks) {
    now = chunk.elapsedMs;
    loader.onDataArrival(new ArrayBuffer(chunk.bytes), total, total + chunk.bytes);
    total += chunk.bytes;
  }
  io.destroy();
  return { firstInputMs, extraWaitMs: firstInputMs == null ? null : firstInputMs - trace.previewChunks[0].elapsedMs };
}
const before = replay(undefined), after = replay('youtube');
console.log(JSON.stringify({ label: trace.label, metadataMs: trace.metadataMs,
  firstBackendPreviewMs: trace.previewMs, chunks: trace.previewChunks.length,
  before, after, savedParserWaitMs: before.firstInputMs == null ? null : before.firstInputMs - after.firstInputMs }, null, 2));
