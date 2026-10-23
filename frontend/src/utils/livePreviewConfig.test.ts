/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { livePreviewConfig } from './livePreviewConfig';

// Load the installed IO controller and its actual dependencies, rather than
// reproducing its buffering algorithm in a test double.
function ioController() {
  const cache = new Map<string, Record<string, unknown>>();
  const load = (file: string): Record<string, unknown> => {
    const existing = cache.get(file);
    if (existing) return existing;
    const exports: Record<string, unknown> = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, allowJs: true },
    }).outputText;
    runInNewContext(code, { exports, self: { performance, navigator: { userAgent: '' } },
      require: (name: string) => name.startsWith('.')
        ? load(path.resolve(path.dirname(file), path.extname(name) ? name : `${name}.js`))
        : createRequire(import.meta.url)(name),
      console, ArrayBuffer, Uint8Array, setTimeout, clearTimeout });
    return exports;
  };
  return load(fileURLToPath(new URL('../../node_modules/mpegts.js/src/io/io-controller.js', import.meta.url))).default as new (
    source: { url: string }, config: Record<string, unknown>, extra: unknown,
  ) => { onDataArrival: (buffer: ArrayBuffer, start: number) => number; open(): void; destroy(): void };
}

it.each([false, true])('YouTube bootstrap reaches the actual demux consumer without waiting for the next HLS batch (thumbnail=%s)', (thumbnail) => {
  const IOController = ioController();
  const loaders: Array<{ onDataArrival: (data: ArrayBuffer, start: number, total: number) => void }> = [];
  class Loader {
    needStashBuffer = true;
    onDataArrival = () => {};
    constructor() { loaders.push(this); }
    open() {} isWorking() { return false; } destroy() {}
  }
  for (const platform of ['bilibili', 'youtube'] as const) {
    const consumer = vi.fn((buffer: ArrayBuffer) => buffer.byteLength);
    const io = new IOController({ url: 'ws://localhost/preview' }, {
      ...livePreviewConfig(thumbnail, undefined, platform), seekType: 'range', customLoader: Loader,
    }, undefined);
    io.onDataArrival = consumer;
    io.open();
    const loader = loaders.at(-1)!;
    // A small complete bootstrap/GOP arrives, then the upstream goes quiet.
    const first = new ArrayBuffer(32 * 1024);
    if (platform === 'youtube') consumer.mockImplementationOnce(buffer => buffer.byteLength - 4);
    loader.onDataArrival(first, 0, first.byteLength);
    if (platform === 'youtube') {
      expect(consumer).toHaveBeenCalledWith(first, 0);
      // Disabling the byte threshold must still retain an incomplete FLV tag
      // and prepend it to the next network packet, without dropping bytes.
      const next = new ArrayBuffer(3);
      loader.onDataArrival(next, first.byteLength, first.byteLength + 3);
      expect(consumer.mock.calls[1][0].byteLength).toBe(7);
    }
    else expect(consumer).not.toHaveBeenCalled();
    io.destroy();
  }
});

// Exercise the installed player's real latency controllers, including the previous failure path.
function controller(name: string) {
  const source = readFileSync(new URL(`../../node_modules/mpegts.js/src/player/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(output, { exports });
  return exports.default as new (config: Record<string, unknown>, video: unknown, seek?: (time: number) => void) => {
    notifyBufferedRangeUpdate(): void;
    destroy(): void;
  };
}

it('缓冲分批增长时，旧策略会反复跳播，新策略不触发强制 seek', () => {
  const Chaser = controller('live-latency-chaser');
  let end = 3;
  const video = { currentTime: 1, paused: false, buffered: { length: 1, end: () => end } };
  const seek = vi.fn((time: number) => { video.currentTime = time; });
  const old = new Chaser({ isLive: true, liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 1.5, liveBufferLatencyMinRemain: 0.5 }, video, seek);
  old.notifyBufferedRangeUpdate(); end = 5; old.notifyBufferedRangeUpdate();
  expect(seek).toHaveBeenCalledTimes(2);
  seek.mockClear();
  const improved = new Chaser({ ...livePreviewConfig(false), isLive: true }, video, seek);
  end = 8; improved.notifyBufferedRangeUpdate(); end = 12; improved.notifyBufferedRangeUpdate();
  expect(seek).not.toHaveBeenCalled();
});

it('积压时仅轻微加速，追赶到目标余量后恢复原速，离开播放器时清理监听', () => {
  const Sync = controller('live-latency-synchronizer');
  let end = 8;
  let onTimeUpdate: (() => void) | undefined;
  const video = { currentTime: 1, playbackRate: 1, buffered: { length: 1, end: () => end },
    addEventListener: vi.fn((_name, cb) => { onTimeUpdate = cb; }), removeEventListener: vi.fn() };
  const sync = new Sync({ ...livePreviewConfig(false), isLive: true }, video);
  onTimeUpdate!(); expect(video.playbackRate).toBe(1.05); expect(video.currentTime).toBe(1);
  end = 4; onTimeUpdate!(); expect(video.playbackRate).toBe(1.05);
  end = 3; onTimeUpdate!(); expect(video.playbackRate).toBe(1);
  sync.destroy(); expect(video.removeEventListener).toHaveBeenCalledWith('timeupdate', onTimeUpdate);
});
