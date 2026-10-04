import { isTauri } from "@tauri-apps/api/core";

export async function enterWallFullscreen(
  element: HTMLElement,
): Promise<() => Promise<void>> {
  if (isTauri()) {
    document.documentElement.classList.add("lr-wall-fullscreen");
    return async () => {
      document.documentElement.classList.remove("lr-wall-fullscreen");
    };
  }
  if (!element.requestFullscreen) throw new Error("当前环境不支持视频区域全屏");
  await element.requestFullscreen();
  return async () => {
    if (document.fullscreenElement === element) await document.exitFullscreen();
  };
}
