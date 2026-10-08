import { create } from 'zustand';
import { loadDanmakuPref, saveDanmakuPref, DANMUKU_DENSITY_OPTIONS } from '../utils/danmakuPrefs';

interface DanmakuPrefsState {
  visible: boolean;
  opacity: number;
  density: number;
  setVisible: (value: boolean) => void;
  setOpacity: (value: number) => void;
  setDensity: (value: number) => void;
}

const savedVisible = loadDanmakuPref<unknown>('visible', true);
const savedOpacity = loadDanmakuPref<unknown>('opacity', 0.9);
const savedDensity = loadDanmakuPref<unknown>('density', 40);

/** 所有预览共用显示偏好；修改立即保存，应用启动时恢复原有偏好键。 */
export const useDanmakuPrefsStore = create<DanmakuPrefsState>((set) => ({
  visible: typeof savedVisible === 'boolean' ? savedVisible : true,
  opacity: typeof savedOpacity === 'number' && Number.isFinite(savedOpacity)
    && savedOpacity >= 0.2 && savedOpacity <= 1 ? savedOpacity : 0.9,
  density: typeof savedDensity === 'number' && DANMUKU_DENSITY_OPTIONS.includes(savedDensity)
    ? savedDensity : 40,
  setVisible(value) {
    saveDanmakuPref('visible', value);
    set({ visible: value });
  },
  setOpacity(value) {
    saveDanmakuPref('opacity', value);
    set({ opacity: value });
  },
  setDensity(value) {
    saveDanmakuPref('density', value);
    set({ density: value });
  },
}));
