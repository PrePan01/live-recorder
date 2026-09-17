import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { nativePickDirectory } from '../../src/api/routes/settings.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

/** 模拟一次对话框调用：按平台跑指定的选择器，再驱动 spawn 出来的子进程。 */
function run(
  platform: NodeJS.Platform,
  pick: () => Promise<unknown>,
  emit: (child: FakeChild) => void,
): Promise<unknown> {
  const original = process.platform;
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  spawnMock.mockReturnValueOnce(child);
  const pending = pick();
  emit(child);
  return pending.finally(() => Object.defineProperty(process, 'platform', { value: original, configurable: true }));
}

/** PowerShell 在 Windows 上以 base64 回传路径，模拟它折行后的 stdout。 */
function powershellOutput(value: string): Buffer {
  return Buffer.from(`${Buffer.from(value, 'utf8').toString('base64')}\r\n`);
}

describe('nativePickDirectory', () => {
  it('restores the base64 directory PowerShell reports on Windows', async () => {
    const windowsDir = 'D:\\录制\\2026 备份';
    const result = await run('win32', nativePickDirectory, (child) => {
      child.stdout.emit('data', powershellOutput(windowsDir));
      child.emit('close');
    });
    expect(result).toBe(windowsDir);
  });

  it('reads the plain POSIX directory osascript reports on macOS', async () => {
    const result = await run('darwin', nativePickDirectory, (child) => {
      child.stdout.emit('data', '/Users/me/Movies/录制\n');
      child.emit('close');
    });
    expect(result).toBe('/Users/me/Movies/录制');
  });

  it('returns null when the user cancels', async () => {
    const result = await run('darwin', nativePickDirectory, (child) => child.emit('close'));
    expect(result).toBeNull();
  });
});
