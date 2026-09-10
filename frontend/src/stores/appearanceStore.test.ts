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
