import { afterEach, expect, it, vi } from 'vitest';
import type { Settings } from '../types/settings';

vi.mock('../api/settings', () => ({ fetchSettings: vi.fn(), updateSettings: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps the search preference across service updates and client reloads', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });

  const { useAppearanceStore } = await import('./appearanceStore');
  const { useSettingsStore } = await import('./settingsStore');
  expect(useAppearanceStore.getState().showGlobalSearch).toBe(false);
  useAppearanceStore.getState().setShowGlobalSearch(true);

  // Older services omit client display preferences from settings responses/events.
  useSettingsStore.getState().setSettings({ theme: 'light' } as Settings);
  expect(useAppearanceStore.getState().showGlobalSearch).toBe(true);

  vi.resetModules();
  const reloaded = (await import('./appearanceStore')).useAppearanceStore;
  expect(reloaded.getState().showGlobalSearch).toBe(true);
  reloaded.getState().setShowGlobalSearch(false);

  vi.resetModules();
  expect((await import('./appearanceStore')).useAppearanceStore.getState().showGlobalSearch).toBe(false);
});

it('defaults covers to visible for old client preferences and persists an explicit opt-out', async () => {
  const saved = new Map<string, string>([['live-recorder-appearance', JSON.stringify({
    state: { showGlobalSearch: true, showStatusBarAlerts: true }, version: 0,
  })]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const { useAppearanceStore } = await import('./appearanceStore');
  expect(useAppearanceStore.getState().showLiveRoomCover).toBe(true);
  expect(useAppearanceStore.getState().showStatusBarAlerts).toBe(true);
  useAppearanceStore.getState().setShowLiveRoomCover(false);
  vi.resetModules();
  const reloaded = (await import('./appearanceStore')).useAppearanceStore;
  expect(reloaded.getState().showLiveRoomCover).toBe(false);
  expect(reloaded.getState().showGlobalSearch).toBe(true);
});
