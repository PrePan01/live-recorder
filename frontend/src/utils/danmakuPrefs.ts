import { readPref, writePref } from './prefStorage';

const LS_PREFIX = 'lr-danmaku-player';

/** 弹幕显示偏好存储；预览与文件回放使用独立的显示开关键。 */
export function loadDanmakuPref<T>(key: string, fallback: T): T {
  return readPref(`${LS_PREFIX}:${key}`, fallback);
}

export function saveDanmakuPref(key: string, value: unknown): void {
  writePref(`${LS_PREFIX}:${key}`, value);
}

export const DANMUKU_DENSITY_OPTIONS = [20, 40, 80];
