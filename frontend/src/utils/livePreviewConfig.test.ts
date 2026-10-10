/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { livePreviewConfig } from './livePreviewConfig';

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
