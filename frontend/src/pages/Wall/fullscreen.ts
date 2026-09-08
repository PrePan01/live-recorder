import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Returns a cleanup that restores the window's original fullscreen state. */
export async function enterWallFullscreen(element: HTMLElement): Promise<() => Promise<void>> {
  if (isTauri()) {
    const window = getCurrentWindow();
    const wasFullscreen = await window.isFullscreen();
    if (!wasFullscreen) await window.setFullscreen(true);
    return async () => {
      if (!wasFullscreen) await window.setFullscreen(false);
    };
  }
  if (!element.requestFullscreen) throw new Error('当前环境不支持视频区域全屏');
  await element.requestFullscreen();
  return async () => {
    if (document.fullscreenElement === element) await document.exitFullscreen();
  };
}
