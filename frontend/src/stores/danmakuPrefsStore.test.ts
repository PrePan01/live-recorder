import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('弹幕显示偏好持久化', () => {
  let saved: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    saved = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('修改立即保存，重启后恢复开关、透明度和密度', async () => {
    const { useDanmakuPrefsStore } = await import('./danmakuPrefsStore');
    const prefs = useDanmakuPrefsStore.getState();
    prefs.setVisible(false);
    prefs.setOpacity(0.6);
    prefs.setDensity(80);
    expect(saved.get('lr-danmaku-player:visible')).toBe('false');
    expect(saved.get('lr-danmaku-player:opacity')).toBe('0.6');
    expect(saved.get('lr-danmaku-player:density')).toBe('80');

    vi.resetModules();
    const restored = (await import('./danmakuPrefsStore')).useDanmakuPrefsStore.getState();
    expect(restored).toMatchObject({ visible: false, opacity: 0.6, density: 80 });
  });

  it('兼容旧偏好键，非法值恢复默认设置', async () => {
    saved.set('lr-danmaku-player:visible', 'false');
    saved.set('lr-danmaku-player:opacity', '"bad"');
    saved.set('lr-danmaku-player:density', '100');
    const { useDanmakuPrefsStore } = await import('./danmakuPrefsStore');
    expect(useDanmakuPrefsStore.getState()).toMatchObject({ visible: false, opacity: 0.9, density: 40 });
  });

  it('预览显示开关与文件回放独立保存和恢复', async () => {
    const { useDanmakuPrefsStore } = await import('./danmakuPrefsStore');
    useDanmakuPrefsStore.getState().setPreviewVisible(false);
    expect(useDanmakuPrefsStore.getState()).toMatchObject({ previewVisible: false, visible: true });
    expect(saved.get('lr-danmaku-player:previewVisible')).toBe('false');
    expect(saved.has('lr-danmaku-player:visible')).toBe(false);

    vi.resetModules();
    const restored = (await import('./danmakuPrefsStore')).useDanmakuPrefsStore;
    expect(restored.getState()).toMatchObject({ previewVisible: false, visible: true });
    restored.getState().setPreviewVisible(true);
    restored.getState().setVisible(false);
    expect(restored.getState()).toMatchObject({ previewVisible: true, visible: false });
    expect(saved.get('lr-danmaku-player:previewVisible')).toBe('true');
  });

  it('存储不可用时仍保留当前会话设置', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('unavailable'); } });
    const { useDanmakuPrefsStore } = await import('./danmakuPrefsStore');
    useDanmakuPrefsStore.getState().setVisible(false);
    useDanmakuPrefsStore.getState().setOpacity(0.4);
    expect(useDanmakuPrefsStore.getState()).toMatchObject({ visible: false, opacity: 0.4 });
  });
  it('字号与速度在预览和历史回看中独立保存，重启后恢复', async () => {
    const prefs = (await import('./danmakuPrefsStore')).useDanmakuPrefsStore.getState();
    expect(prefs).toMatchObject({ fontScale: 1, speedMultiplier: 1, previewFontScale: 1, previewSpeedMultiplier: 1 });
    prefs.setPreviewFontScale(2);
    prefs.setPreviewSpeedMultiplier(0.5);
    expect((await import('./danmakuPrefsStore')).useDanmakuPrefsStore.getState()).toMatchObject({ fontScale: 1, speedMultiplier: 1 });
    prefs.setFontScale(0.7);
    prefs.setSpeedMultiplier(1.8);
    vi.resetModules();
    expect((await import('./danmakuPrefsStore')).useDanmakuPrefsStore.getState()).toMatchObject({
      fontScale: 0.7, speedMultiplier: 1.8, previewFontScale: 2, previewSpeedMultiplier: 0.5,
    });
  });

  it('新增偏好的非法值回退到 1，存储不可用也可调整', async () => {
    saved.set('lr-danmaku-player:fontScale', '0.4');
    saved.set('lr-danmaku-player:speedMultiplier', '3');
    saved.set('lr-danmaku-player:previewFontScale', '"bad"');
    saved.set('lr-danmaku-player:previewSpeedMultiplier', 'null');
    const store = (await import('./danmakuPrefsStore')).useDanmakuPrefsStore;
    expect(store.getState()).toMatchObject({ fontScale: 1, speedMultiplier: 1, previewFontScale: 1, previewSpeedMultiplier: 1 });
    store.getState().setFontScale(NaN);
    store.getState().setSpeedMultiplier(Infinity);
    expect(store.getState()).toMatchObject({ fontScale: 1, speedMultiplier: 1 });
    vi.stubGlobal('window', { get localStorage() { throw new Error('unavailable'); } });
    store.getState().setPreviewFontScale(1.5);
    store.getState().setPreviewSpeedMultiplier(0.8);
    expect(store.getState()).toMatchObject({ previewFontScale: 1.5, previewSpeedMultiplier: 0.8 });
  });

});
