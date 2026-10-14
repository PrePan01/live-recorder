import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { http } from './client';
import type { ExportConfig } from '../types/config';

let useAppearanceStore: typeof import('../stores/appearanceStore').useAppearanceStore;
let exportConfig: typeof import('./config').exportConfig;
let exportConfigToFile: typeof import('./config').exportConfigToFile;
let importConfig: typeof import('./config').importConfig;

vi.mock('./client', () => ({ http: { get: vi.fn(), post: vi.fn() } }));

beforeEach(async () => {
  vi.resetModules();
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  ({ useAppearanceStore } = await import('../stores/appearanceStore'));
  ({ exportConfig, exportConfigToFile, importConfig } = await import('./config'));
  useAppearanceStore.setState({ showGlobalSearch: true, showStatusBarAlerts: false, showLiveRoomCover: true });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])('round-trips the alert preference through a JSON backup (%s)', async (enabled) => {
  const serviceConfig = { version: 1, settings: { theme: 'light' }, rooms: [] } as unknown as ExportConfig;
  vi.mocked(http.get).mockResolvedValue({ data: { config: serviceConfig } });
  vi.mocked(http.post).mockResolvedValue({ data: { ok: true } });
  useAppearanceStore.getState().setShowStatusBarAlerts(enabled);
  const backup = JSON.parse(JSON.stringify(await exportConfig()));
  expect(backup.appearance).toEqual({ showStatusBarAlerts: enabled, showLiveRoomCover: true });
  expect(backup.settings).toEqual(serviceConfig.settings);

  useAppearanceStore.getState().setShowStatusBarAlerts(!enabled);
  await importConfig(backup);
  expect(useAppearanceStore.getState().showStatusBarAlerts).toBe(enabled);
  expect(useAppearanceStore.getState().showGlobalSearch).toBe(true);
  // The imported value is also saved for the next client launch.
  const stored = JSON.parse(localStorage.getItem('live-recorder-appearance')!);
  expect(stored.state.showStatusBarAlerts).toBe(enabled);
});

it.each([true, false])('includes the preference in native file exports (%s)', async (enabled) => {
  useAppearanceStore.getState().setShowStatusBarAlerts(enabled);
  vi.mocked(http.post).mockResolvedValue({ data: { ok: true, saved: true } });
  await exportConfigToFile();
  expect(http.post).toHaveBeenCalledWith('/config/export-file', {
    appearance: { showStatusBarAlerts: enabled, showLiveRoomCover: true },
  }, { timeout: 0 });
});

it('preserves the current preference for old backups and invalid values', async () => {
  vi.mocked(http.post).mockResolvedValue({ data: { ok: true } });
  useAppearanceStore.getState().setShowStatusBarAlerts(true);
  for (const backup of [{ version: 1 }, { appearance: {} }, { appearance: { showStatusBarAlerts: 'false' } }]) {
    await importConfig(backup as never);
    expect(useAppearanceStore.getState().showStatusBarAlerts).toBe(true);
  }
});

it('preserves the preference when the service rejects an import', async () => {
  vi.mocked(http.post).mockRejectedValue(new Error('导入失败'));
  await expect(importConfig({ appearance: { showStatusBarAlerts: true } })).rejects.toThrow('导入失败');
  expect(useAppearanceStore.getState().showStatusBarAlerts).toBe(false);
});

it.each([true, false])('round-trips cover visibility through both export paths (%s)', async (enabled) => {
  vi.mocked(http.get).mockResolvedValue({ data: { config: { version: 1 } } });
  vi.mocked(http.post).mockResolvedValue({ data: { ok: true, saved: true } });
  useAppearanceStore.getState().setShowLiveRoomCover(enabled);
  const backup = JSON.parse(JSON.stringify(await exportConfig()));
  expect(backup.appearance.showLiveRoomCover).toBe(enabled);
  await exportConfigToFile();
  expect(http.post).toHaveBeenCalledWith('/config/export-file', {
    appearance: { showStatusBarAlerts: false, showLiveRoomCover: enabled },
  }, { timeout: 0 });
  useAppearanceStore.getState().setShowLiveRoomCover(!enabled);
  await importConfig(backup);
  expect(useAppearanceStore.getState().showLiveRoomCover).toBe(enabled);
  expect(JSON.parse(localStorage.getItem('live-recorder-appearance')!).state.showLiveRoomCover).toBe(enabled);
});

it.each([true, false])('leaves cover visibility unchanged for legacy or invalid backups (%s)', async (enabled) => {
  vi.mocked(http.post).mockResolvedValue({ data: { ok: true } });
  useAppearanceStore.getState().setShowLiveRoomCover(enabled);
  for (const backup of [{ version: 1 }, { appearance: { showStatusBarAlerts: true } }, { appearance: { showLiveRoomCover: 'false' } }]) {
    await importConfig(backup as never);
    expect(useAppearanceStore.getState().showLiveRoomCover).toBe(enabled);
  }
  vi.mocked(http.post).mockRejectedValue(new Error('导入失败'));
  await expect(importConfig({ appearance: { showLiveRoomCover: !enabled } })).rejects.toThrow('导入失败');
  expect(useAppearanceStore.getState().showLiveRoomCover).toBe(enabled);
});
