import { readPref, writePref } from './prefStorage';

const LS_PREFIX = 'lr-danmaku-player';

/** 弹幕显示偏好（播放器与预览共用一套）；内核走 prefStorage 共享容错。 */
export function loadDanmakuPref<T>(key: string, fallback: T): T {
  return readPref(`${LS_PREFIX}:${key}`, fallback);
}

export function saveDanmakuPref(key: string, value: unknown): void {
  writePref(`${LS_PREFIX}:${key}`, value);
}

export const DANMUKU_DENSITY_OPTIONS = [20, 40, 80];
