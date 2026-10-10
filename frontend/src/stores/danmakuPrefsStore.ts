import { create } from 'zustand';
import { loadDanmakuPref, saveDanmakuPref, DANMUKU_DENSITY_OPTIONS } from '../utils/danmakuPrefs';

interface DanmakuPrefsState {
  visible: boolean;
  previewVisible: boolean;
  opacity: number;
  density: number;
  setVisible: (value: boolean) => void;
  setPreviewVisible: (value: boolean) => void;
  setOpacity: (value: number) => void;
  setDensity: (value: number) => void;
}

const savedVisible = loadDanmakuPref<unknown>('visible', true);
const savedPreviewVisible = loadDanmakuPref<unknown>('previewVisible', true);
const savedOpacity = loadDanmakuPref<unknown>('opacity', 0.9);
const savedDensity = loadDanmakuPref<unknown>('density', 40);

/** 预览与文件回放分别保存显示开关，共用透明度和密度；均不影响录制采集。 */
export const useDanmakuPrefsStore = create<DanmakuPrefsState>((set) => ({
  visible: typeof savedVisible === 'boolean' ? savedVisible : true,
  previewVisible: typeof savedPreviewVisible === 'boolean' ? savedPreviewVisible : true,
  opacity: typeof savedOpacity === 'number' && Number.isFinite(savedOpacity)
    && savedOpacity >= 0.2 && savedOpacity <= 1 ? savedOpacity : 0.9,
  density: typeof savedDensity === 'number' && DANMUKU_DENSITY_OPTIONS.includes(savedDensity)
    ? savedDensity : 40,
  setVisible(value) {
    saveDanmakuPref('visible', value);
    set({ visible: value });
  },
  setPreviewVisible(value) {
    saveDanmakuPref('previewVisible', value);
    set({ previewVisible: value });
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
