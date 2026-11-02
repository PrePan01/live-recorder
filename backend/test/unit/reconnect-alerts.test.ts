import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';
import { FakeRecordingEngine, type FakeEngineScript } from '../../src/recorder/fake-engine.js';
import { AppError } from '../../src/types/error.js';

const networkError = () => new AppError('NETWORK_UNAVAILABLE', '网络暂时不可用', { retryable: true }).toObject();

async function setup() {
  const clock = new FakeClock();
  const directory = await mkdtemp(path.join(tmpdir(), 'lr-reconnect-alerts-'));
  const services = buildServices({ dbPath: ':memory:', clock, mode: 'fake' });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: directory, autoRecord: true });
  const script: FakeEngineScript = {
    frames: 100_000, intervalMs: 500, failAfterMs: 30, failError: networkError(),
  };
  services.engineFor = () => new FakeRecordingEngine(clock, script);
  const probe = vi.spyOn(services.adapterFor('bilibili'), 'checkLiveStatus')
    .mockResolvedValue({ status: 'error', error: networkError() });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: 'Reconnect' });
  const alerts = () => services.alerts.list({ limit: 1000 }).filter(alert => alert.source === 'recorder');
  const created: string[] = [];
  services.events.on(event => { if (event.type === 'alert:created' && event.data.source === 'recorder') created.push(event.data.id); });
  const step = async (ms = 5000) => {
    clock.advance(ms);
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await step(500);
    }
    throw new Error('recording transition timed out');
  };
  const start = async () => {
    expect(await services.manager.maybeStartRecording(room, { streamSessionId: 'same-broadcast' })).toBe(true);
    return services.recordings.list({ roomId: room.id }).items[0]!;
  };
  const cleanup = async () => {
    await services.manager.shutdown();
    services.db.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { services, clock, room, script, probe, alerts, created, step, until, start, cleanup };
}

describe('recording reconnect alerts', () => {
  it('reports one cause and one five-minute warning while continuing retries and respecting read state', async () => {
    const h = await setup();
    try {
      const rec = await h.start();
      await h.until(() => h.alerts().length === 1);
      const first = h.alerts()[0]!;
      h.services.alerts.markRead(first.id);
      for (let i = 0; i < 30; i++) await h.step(30_000);
      expect(h.probe.mock.calls.length).toBeGreaterThan(10);
      expect(h.services.recordings.get(rec.id)).toMatchObject({ state: 'reconnecting' });
      expect(h.services.manager.isRoomActive(h.room.id)).toBe(true);
      expect(h.alerts()).toHaveLength(2);
      expect(h.alerts().filter(a => a.message === '正在努力恢复该直播间录制')).toHaveLength(1);
      expect(h.services.alerts.get(first.id)?.read).toBe(true);
      expect(h.created).toHaveLength(2);
      await h.services.manager.stopRecording(h.room.id);
      expect(h.services.recordings.get(rec.id)).toMatchObject({ endReason: 'stopped', failureReason: null });
      expect(h.services.manager.isRoomActive(h.room.id)).toBe(false);
      expect(h.services.recordings.list({ roomId: h.room.id }).items).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('preserves new causes, suppresses alternating duplicates, and alerts again after actual media recovery', async () => {
    const h = await setup();
    try {
      const rec = await h.start();
      await h.until(() => h.alerts().length === 1);
      const filePath = h.services.recordings.get(rec.id)!.filePath;
      h.probe.mockResolvedValue({ status: 'error', error: new AppError('PLATFORM_SERVER_ERROR', '平台暂时异常', { retryable: true }).toObject() });
      await h.until(() => h.alerts().some(a => a.errorCode === 'PLATFORM_SERVER_ERROR'));
      h.probe.mockResolvedValue({ status: 'error', error: networkError() });
      for (let i = 0; i < 4; i++) await h.step(30_000);
      expect(h.alerts()).toHaveLength(2);

      // A fresh URL alone does not reset alerts; this engine actually supplies media.
      delete h.script.failAfterMs;
      h.probe.mockResolvedValue({ status: 'live', streamSessionId: 'same-broadcast' });
      await h.until(() => h.services.recordings.get(rec.id)!.state === 'recording');
      h.script.failAfterMs = 30;
      h.probe.mockResolvedValue({ status: 'error', error: networkError() });
      await h.until(() => h.alerts().length === 3);
      expect(h.alerts().filter(a => a.errorCode === 'NETWORK_UNAVAILABLE')).toHaveLength(2);
      expect(h.services.recordings.get(rec.id)!.filePath).toBe(filePath);
      expect(h.services.recordings.list({ roomId: h.room.id }).items).toHaveLength(1);
      await h.services.manager.stopRecording(h.room.id);
    } finally { await h.cleanup(); }
  });

  it('does not restart the alert cycle when repeated pulls time out without any media', async () => {
    const h = await setup();
    let pulls = 0;
    h.probe.mockResolvedValue({ status: 'live', streamSessionId: 'same-broadcast' });
    h.services.engineFor = () => {
      let finish: (() => void) | undefined;
      return {
        async *start(): AsyncGenerator<never, void> {
          pulls++;
          await new Promise<void>(resolve => { finish = resolve; });
        },
        async stop() { finish?.(); },
      };
    };
    try {
      await h.start();
      for (let i = 0; i < 32; i++) await h.step(30_000);
      expect(pulls).toBeGreaterThan(5);
      expect(h.services.manager.isRoomActive(h.room.id)).toBe(true);
      expect(h.alerts().filter(a => a.errorCode === 'RECORDING_START_TIMEOUT')).toHaveLength(1);
      expect(h.alerts().filter(a => a.message === '正在努力恢复该直播间录制')).toHaveLength(1);
      expect(h.created).toHaveLength(2);
    } finally { await h.cleanup(); }
  });

  it('does not suppress another room or the terminal error after a non-retryable failure', async () => {
    const h = await setup();
    try {
      await h.start();
      await h.until(() => h.alerts().length === 1);
      const other = h.services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/456', displayName: 'Other' });
      expect(await h.services.manager.maybeStartRecording(other, { streamSessionId: 'other-broadcast' })).toBe(true);
      await h.until(() => h.alerts().some(a => a.roomId === other.id));
      expect(h.alerts().filter(a => a.message.includes('正在自动重试'))).toHaveLength(2);
      h.probe.mockResolvedValue({ status: 'restricted', error: new AppError('PLATFORM_ACCESS_RESTRICTED', '访问受限', { retryable: false }).toObject() });
      await h.until(() => !h.services.manager.isRoomActive(h.room.id) && !h.services.manager.isRoomActive(other.id));
      expect(h.alerts().filter(a => a.level === 'error')).toHaveLength(2);
    } finally { await h.cleanup(); }
  });
});
