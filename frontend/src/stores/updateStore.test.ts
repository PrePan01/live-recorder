import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { bridge } from './bootStore';
import { startUpdateMonitoring, useUpdateStore } from './updateStore';
import type { UpdateState } from '../types/update';
vi.mock('./bootStore', () => ({ bridge: {
  isDesktop: true, checkUpdate: vi.fn(), downloadUpdate: vi.fn(), getUpdateState: vi.fn(), onUpdateState: vi.fn(),
} }));
const available: UpdateState = {
  revision: 2, currentVersion: '0.5.111', phase: 'available', downloaded: 0, error: null,
  update: { version: '0.5.112', asset: { filename: 'app.msi', url: 'https://example.com/app.msi', size: 100, sha256: '' } },
};
beforeEach(() => { vi.resetAllMocks(); useUpdateStore.setState({ state: null, checking: false }); });
afterEach(() => { vi.useRealTimers(); });
describe('update state synchronization', () => {
  it('merges concurrent manual and automatic checks', async () => {
    let resolve!: (state: UpdateState) => void;
    vi.mocked(bridge.checkUpdate).mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = useUpdateStore.getState().check(); const b = useUpdateStore.getState().check();
    expect(a).toBe(b); expect(bridge.checkUpdate).toHaveBeenCalledTimes(1);
    resolve(available); await a;
    expect(useUpdateStore.getState().state).toEqual(available);
    expect(useUpdateStore.getState().checking).toBe(false);
  });
  it('preserves a known update on check failures and allows retry', async () => {
    useUpdateStore.getState().accept(available);
    vi.mocked(bridge.checkUpdate).mockRejectedValueOnce('offline').mockResolvedValueOnce(available);
    await expect(useUpdateStore.getState().check()).rejects.toBe('offline');
    expect(useUpdateStore.getState().state).toEqual(available);
    await useUpdateStore.getState().check();
    expect(bridge.checkUpdate).toHaveBeenCalledTimes(2);
  });
  it('rejects late snapshots and pauses checks while downloading', async () => {
    const downloading = { ...available, revision: 3, phase: 'downloading' as const, downloaded: 50 };
    useUpdateStore.getState().accept(downloading); useUpdateStore.getState().accept(available);
    await useUpdateStore.getState().check();
    expect(bridge.checkUpdate).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().state).toEqual(downloading);
  });
  it('merges downloads and allows retry after a failure', async () => {
    let reject!: (e: string) => void;
    vi.mocked(bridge.downloadUpdate).mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    const first = useUpdateStore.getState().download();
    expect(useUpdateStore.getState().download()).toBe(first);
    reject('disk full'); await expect(first).rejects.toBe('disk full');
    vi.mocked(bridge.downloadUpdate).mockResolvedValue({ ...available, phase: 'ready', downloaded: 100 });
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().state?.phase).toBe('ready');
  });
  it('subscribes before the snapshot and checks every four hours with cleanup', async () => {
    vi.useFakeTimers(); const off = vi.fn();
    vi.mocked(bridge.onUpdateState).mockResolvedValue(off);
    vi.mocked(bridge.getUpdateState).mockResolvedValue(available);
    vi.mocked(bridge.checkUpdate).mockResolvedValue(available);
    const stop = startUpdateMonitoring(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(bridge.onUpdateState).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bridge.getUpdateState).mock.invocationCallOrder[0]);
    expect(bridge.checkUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(bridge.checkUpdate).toHaveBeenCalledTimes(2);
    stop(); expect(off).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(bridge.checkUpdate).toHaveBeenCalledTimes(2);
  });
});
