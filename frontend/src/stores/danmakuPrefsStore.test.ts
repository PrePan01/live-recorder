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

  it('存储不可用时仍保留当前会话设置', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('unavailable'); } });
    const { useDanmakuPrefsStore } = await import('./danmakuPrefsStore');
    useDanmakuPrefsStore.getState().setVisible(false);
    useDanmakuPrefsStore.getState().setOpacity(0.4);
    expect(useDanmakuPrefsStore.getState()).toMatchObject({ visible: false, opacity: 0.4 });
  });
});
