import { afterEach, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { enterWallFullscreen } from './fullscreen';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('uses native fullscreen without requiring the WebView DOM API, then restores the window', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const setFullscreen = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    isFullscreen: vi.fn().mockResolvedValue(false), setFullscreen,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const restore = await enterWallFullscreen({} as HTMLElement);
  expect(setFullscreen).toHaveBeenCalledWith(true);
  await restore();
  expect(setFullscreen.mock.calls).toEqual([[true], [false]]);
});

it('preserves a window that was already fullscreen', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const setFullscreen = vi.fn();
  vi.mocked(getCurrentWindow).mockReturnValue({
    isFullscreen: vi.fn().mockResolvedValue(true), setFullscreen,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  await (await enterWallFullscreen({} as HTMLElement))();
  expect(setFullscreen).not.toHaveBeenCalled();
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
  expect(getCurrentWindow).not.toHaveBeenCalled();
});

it('propagates native permission failures without reporting a successful entry', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(getCurrentWindow).mockReturnValue({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn().mockRejectedValue(new Error('denied')),
  } as unknown as ReturnType<typeof getCurrentWindow>);
  await expect(enterWallFullscreen({} as HTMLElement)).rejects.toThrow('denied');
});
