import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServiceStatus } from '../api/service';
import { useServiceStore } from './serviceStore';
import type { ServiceStatus } from '../types/service';

vi.mock('../api/service', () => ({ fetchServiceStatus: vi.fn() }));
const status: ServiceStatus = {
  state: 'running', version: null, disk: { freeBytes: 100, totalBytes: 200 },
  activeRecordings: 2, setupCompleted: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  useServiceStore.setState({ status: null, loading: false, error: null });
});
describe('service status during connection failures', () => {
  it('preserves completed setup and recordings when a refresh fails', async () => {
    useServiceStore.setState({ status });
    vi.mocked(fetchServiceStatus).mockRejectedValue(new Error('offline'));
    await useServiceStore.getState().fetchStatus();
    expect(useServiceStore.getState().status).toEqual(status);
    expect(useServiceStore.getState().error).toBeTruthy();
  });
  it('keeps initial setup unknown until a successful retry', async () => {
    vi.mocked(fetchServiceStatus).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(status);
    await useServiceStore.getState().fetchStatus();
    expect(useServiceStore.getState().status).toBeNull();
    expect(useServiceStore.getState().loading).toBe(false);
    await useServiceStore.getState().fetchStatus();
    expect(useServiceStore.getState().status?.setupCompleted).toBe(true);
    expect(useServiceStore.getState().error).toBeNull();
  });
  it('accepts a real unconfigured response', async () => {
    vi.mocked(fetchServiceStatus).mockResolvedValue({ ...status, setupCompleted: false });
    await useServiceStore.getState().fetchStatus();
    expect(useServiceStore.getState().status?.setupCompleted).toBe(false);
  });
});
