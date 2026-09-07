import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BootEvent, BootState } from '../types/desktop';
const mock = vi.hoisted(() => ({
  startService: vi.fn(),
  restartService: vi.fn(),
  getDiagnostics: vi.fn(),
  onBootState: vi.fn(),
  onTray: vi.fn(),
  onExistingInstance: vi.fn(),
}));
vi.mock('../bridge/nativeBridge', () => ({ detectBridge: () => mock }));
import { subscribeBridgeEvents, useBootStore } from './bootStore';
import { EndpointResolver } from '../api/endpoint';
const ready: BootEvent = {
  state: 'ready',
  diagnostics: [],
  instance: {
    instanceId: 'test',
    pid: 123,
    port: 43121,
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:43121',
    apiVersion: 'v1',
    startedAt: '',
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  EndpointResolver.reset();
  useBootStore.setState({
    state: 'booting',
    loading: false,
    instance: null,
    diagnostics: [],
  });
  mock.getDiagnostics.mockResolvedValue([]);
  mock.onBootState.mockReturnValue(() => {});
  mock.onTray.mockReturnValue(() => {});
  mock.onExistingInstance.mockReturnValue(() => {});
});
afterEach(() => vi.useRealTimers());
it('coalesces duplicate boot and restart requests during startup', async () => {
  let resolve!: (event: BootEvent) => void;
  mock.startService.mockReturnValue(
    new Promise<BootEvent>((r) => {
      resolve = r;
    }),
  );
  const first = useBootStore.getState().boot();
  await useBootStore.getState().boot();
  await useBootStore.getState().restart();
  expect(mock.startService).toHaveBeenCalledTimes(1);
  expect(mock.restartService).not.toHaveBeenCalled();
  resolve(ready);
  await first;
  expect(useBootStore.getState().state).toBe('ready');
  expect(EndpointResolver.base).toBe('http://127.0.0.1:43121/api/v1');
});
it('keeps observing a slow startup and accepts its eventual success without spawning again', async () => {
  let resolve!: (event: BootEvent) => void;
  mock.startService.mockReturnValue(
    new Promise<BootEvent>((r) => {
      resolve = r;
    }),
  );
  const pending = useBootStore.getState().boot();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(useBootStore.getState().state).toBe('booting');
  expect(useBootStore.getState().loading).toBe(true);
  expect(useBootStore.getState().slow).toBe(true);
  await useBootStore.getState().restart();
  expect(mock.restartService).not.toHaveBeenCalled();
  resolve(ready);
  await pending;
  expect(useBootStore.getState().state).toBe('ready');
  expect(useBootStore.getState().slow).toBe(false);
});
it('preserves detailed backend errors when opening diagnostics', async () => {
  const diagnostics = [
    {
      key: 'service',
      message: '后端退出',
      detail: 'exit code 17: missing module',
    },
  ];
  mock.startService.mockResolvedValue({ state: 'degraded', diagnostics });
  mock.getDiagnostics.mockResolvedValue(diagnostics);
  await useBootStore.getState().boot();
  await useBootStore.getState().refreshDiagnostics();
  expect(useBootStore.getState().diagnostics).toEqual(diagnostics);
});
it('does not replace the running workspace when a second app instance is opened', async () => {
  const off = subscribeBridgeEvents();
  useBootStore.setState({ state: 'ready' });
  mock.onExistingInstance.mock.calls[0][0]();
  expect(useBootStore.getState().state).toBe('ready');
  off();
});
it('does not regress ready on a delayed native booting event', async () => {
  const off = subscribeBridgeEvents();
  mock.startService.mockResolvedValue(ready);
  await useBootStore.getState().boot();
  const callback = mock.onBootState.mock.calls[0][0] as (
    state: BootState,
  ) => void;
  callback('booting');
  expect(useBootStore.getState().state).toBe('ready');
  off();
});
it('uses restartService for the tray restart action', async () => {
  const off = subscribeBridgeEvents();
  mock.restartService.mockResolvedValue(ready);
  mock.onTray.mock.calls[0][0]('restart');
  await vi.waitFor(() => expect(useBootStore.getState().loading).toBe(false));
  expect(mock.restartService).toHaveBeenCalledTimes(1);
  expect(mock.startService).not.toHaveBeenCalled();
  off();
});
