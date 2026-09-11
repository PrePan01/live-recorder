import { isTauri } from '@tauri-apps/api/core';

/** Returns a cleanup that restores the original fullscreen state. */
export async function enterWallFullscreen(element: HTMLElement): Promise<() => Promise<void>> {
  if (isTauri()) {
    // 客户端：只在「应用窗口内」把视频网格铺满，不触发整个 OS 窗口全屏。
    // 同时用根类消除祖先 .lr-page 的 transform 动画产生的 fixed 包含块，
    // 否则 position:fixed 的网格会相对 .lr-page 定位而塌成一小行。
    document.documentElement.classList.add('lr-wall-fullscreen');
    return async () => {
      document.documentElement.classList.remove('lr-wall-fullscreen');
    };
  }
  if (!element.requestFullscreen) throw new Error('当前环境不支持视频区域全屏');
  await element.requestFullscreen();
  return async () => {
    if (document.fullscreenElement === element) await document.exitFullscreen();
  };
}
