import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFfmpegTracked } from '../../src/recorder/ffmpeg-run.js';
import { trackedFfmpegCount } from '../../src/recorder/ffmpeg-registry.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    // 固定竞争结果：收到 kill 时进程已经按 EOF 成功退出。
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; }),
  });
  spawnMock.mockReturnValue(child);
  return child;
}

beforeEach(() => spawnMock.mockReset());

describe('FFmpeg lifecycle across platforms', () => {
  it('fails on input read errors even when the child exits with code zero', async () => {
    processFixture();
    const result = await runFfmpegTracked([], {
      input: () => Readable.from((async function* () {
        yield Buffer.alloc(4);
        throw new Error('disk read failed');
      })()),
    });
    expect(result).toMatchObject({ ok: false, code: 0 });
    expect(result.stderr).toContain('disk read failed');
    expect(trackedFfmpegCount()).toBe(0);
  });

  it('fails when the input factory throws, regardless of the exit code', async () => {
    processFixture();
    const result = await runFfmpegTracked([], { input: () => { throw new Error('open failed'); } });
    expect(result).toMatchObject({ ok: false, code: 0 });
    expect(result.stderr).toContain('open failed');
    expect(trackedFfmpegCount()).toBe(0);
  });

  it('cancels and destroys input even when a late exit reports success', async () => {
    processFixture();
    const abort = new AbortController();
    const input = new Readable({ read() {} });
    const result = runFfmpegTracked([], { input: () => input, signal: abort.signal });
    abort.abort();
    await expect(result).resolves.toMatchObject({ ok: false, code: 0 });
    expect(input.destroyed).toBe(true);
    expect(trackedFfmpegCount()).toBe(0);
  });

  it('does not open input when cancellation predates the job', async () => {
    processFixture();
    const abort = new AbortController();
    abort.abort();
    const input = vi.fn(() => new Readable({ read() {} }));
    await expect(runFfmpegTracked([], { input, signal: abort.signal })).resolves.toMatchObject({ ok: false });
    expect(input).not.toHaveBeenCalled();
    expect(trackedFfmpegCount()).toBe(0);
  });
});
