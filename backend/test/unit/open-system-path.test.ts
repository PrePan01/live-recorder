import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { openSystemPath } from '../../src/utils/open-system-path.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

describe('system default file application', () => {
  it.each([
    ['darwin', 'open', '/Users/user/录像/片段 & 测试.mp4'],
    ['win32', 'explorer', 'C:\\录像 文件\\片段 & 测试.mp4'],
    ['linux', 'xdg-open', '/home/user/录像/片段.mp4'],
  ] as const)('%s uses the existing platform launcher with a literal path', async (platform, command, file) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValueOnce(child);
    const pending = openSystemPath(file, platform);
    expect(spawnMock).toHaveBeenLastCalledWith(command, [file], { detached: true, stdio: 'ignore' });
    child.emit('spawn');
    await pending;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('rejects launch errors rather than silently reporting success or crashing', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValueOnce(child);
    const pending = openSystemPath('/missing.mp4', 'darwin');
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');
    expect(child.unref).not.toHaveBeenCalled();
  });
});
