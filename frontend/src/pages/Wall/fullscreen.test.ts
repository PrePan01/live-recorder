import { afterEach, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { enterWallFullscreen } from './fullscreen';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('Tauri: enters in-app fullscreen via a root class (not OS window fullscreen), then restores', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const add = vi.fn();
  const remove = vi.fn();
  vi.stubGlobal('document', { documentElement: { classList: { add, remove } } });
  const restore = await enterWallFullscreen({} as HTMLElement);
  expect(add).toHaveBeenCalledWith('lr-wall-fullscreen');
  await restore();
  expect(remove).toHaveBeenCalledWith('lr-wall-fullscreen');
});

it('keeps browser element fullscreen and tolerates an external exit', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const element = { requestFullscreen: vi.fn().mockResolvedValue(undefined) } as unknown as HTMLElement;
  const exitFullscreen = vi.fn().mockResolvedValue(undefined);
  const documentMock = { fullscreenElement: element as HTMLElement | null, exitFullscreen };
  vi.stubGlobal('document', documentMock);
  const restore = await enterWallFullscreen(element);
  expect(element.requestFullscreen).toHaveBeenCalledOnce();
  await restore();
  expect(exitFullscreen).toHaveBeenCalledOnce();
  documentMock.fullscreenElement = null;
  await restore();
  expect(exitFullscreen).toHaveBeenCalledOnce();
});

it('browser: throws when the element fullscreen API is unavailable', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.stubGlobal('document', {});
  await expect(enterWallFullscreen({} as HTMLElement)).rejects.toThrow('当前环境不支持视频区域全屏');
});

it('Tauri: does not require a video element reference', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal('document', { documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });
  await expect(enterWallFullscreen(undefined as unknown as HTMLElement)).resolves.toBeTypeOf('function');
});
