const LS_PREFIX = 'lr-danmaku-player';

/** 弹幕显示偏好（播放器与预览共用一套，两侧切换保持一致）。 */
export function loadDanmakuPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}:${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveDanmakuPref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`${LS_PREFIX}:${key}`, JSON.stringify(value));
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
}

export const DANMUKU_DENSITY_OPTIONS = [20, 40, 80];
