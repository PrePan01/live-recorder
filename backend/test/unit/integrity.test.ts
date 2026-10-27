import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkFileIntegrity, checkFileIntegrityDetailed } from '../../src/recorder/integrity.js';

const spawnMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs/promises', () => ({ access: accessMock }));

function probe() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  spawnMock.mockReturnValue(child);
  return child;
}

beforeEach(() => { spawnMock.mockReset(); accessMock.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

describe.each([
  { name: 'legacy', check: checkFileIntegrity, valid: 'verified', invalid: 'failed', unavailable: 'pending', timeout: 'pending' },
  { name: 'detailed', check: checkFileIntegrityDetailed, valid: { outcome: 'ok', detail: '' },
    invalid: { outcome: 'failed', detail: '文件损坏或截断' },
    unavailable: { outcome: 'unverifiable', detail: 'ffprobe 不可用' },
    timeout: { outcome: 'unverifiable', detail: '校验超时' } },
])('file integrity ($name)', ({ name, check, valid, invalid, unavailable, timeout }) => {
  it('accepts a decodable file with positive duration', async () => {
    const child = probe();
    const result = check('recording.flv');
    child.stdout.write('{"format":{"duration":"2.5"}}');
    child.emit('close', 0);
    await expect(result).resolves.toEqual(valid);
  });

  it('rejects a non-zero exit even with valid duration output', async () => {
    const child = probe();
    const result = check('recording.flv');
    child.stdout.write('{"format":{"duration":"2.5"}}');
    child.emit('close', 1);
    await expect(result).resolves.toEqual(invalid);
  });

  it.each([
    ['{"format":{"duration":"0"}}', '时长为 0'],
    ['invalid JSON', '无法解析媒体信息'],
  ])('rejects invalid media information: %s', async (output, detail) => {
    const child = probe();
    const result = check('recording.flv');
    child.stdout.write(output);
    child.emit('close', 0);
    await expect(result).resolves.toEqual(name === 'legacy' ? 'failed' : { outcome: 'failed', detail });
  });

  it('degrades when ffprobe is missing, even if close follows error', async () => {
    const child = probe();
    const result = check('recording.flv');
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    child.emit('close', -2);
    await expect(result).resolves.toEqual(unavailable);
  });

  it.each(['ENOENT', 'EACCES', 'EIO'])('does not call inaccessible storage corrupt (%s)', async (code) => {
    accessMock.mockRejectedValue(Object.assign(new Error(code), { code }));
    const child = probe();
    const result = check('offline.flv');
    child.emit('close', 1);
    await expect(result).resolves.toEqual(name === 'legacy' ? 'pending' : {
      outcome: 'unverifiable', detail: '录像文件暂不可访问，请检查存储设备与读取权限后重试',
    });
  });

  it('recognizes I/O failure even when the path still exists', async () => {
    const child = probe();
    const result = check('offline.flv');
    child.stderr.write('Input/output error');
    child.emit('close', 1);
    await expect(result).resolves.toEqual(name === 'legacy' ? 'pending' : {
      outcome: 'unverifiable', detail: '录像文件暂不可访问，请检查存储设备与读取权限后重试',
    });
  });

  it('kills a timed-out probe and retains the degraded result after late success', async () => {
    vi.useFakeTimers();
    const child = probe();
    const result = check('recording.flv', 200);
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.stdout.write('{"format":{"duration":"2.5"}}');
    child.emit('close', 0);
    await expect(result).resolves.toEqual(timeout);
  });
});
