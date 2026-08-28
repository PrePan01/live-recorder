import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';
import { buildServices, type Services } from '../../src/core/services.js';
import type { AppSettings } from '../../src/types/index.js';

function newServices(): { services: Services; clock: FakeClock } {
  const clock = new FakeClock();
  return { services: buildServices({ dbPath: ':memory:', clock }), clock };
}

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function settle(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

function baseSettings(dir = ''): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: 'original',
    checkIntervalSec: { default: 60, bilibili: 30, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
    mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    dedupeWindowMinutes: 30,
  };
}

describe('Scheduler', () => {
  it('checks each platform at its own interval and reschedules serially', async () => {
    const { services, clock } = newServices();
    services.settings.save(baseSettings());
    const r1 = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'B' });
    const r2 = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/2', displayName: 'D' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'offline' }, { status: 'offline' }, { status: 'offline' }, { status: 'offline' },
      { status: 'offline' }, { status: 'offline' }, { status: 'offline' }, { status: 'offline' },
      { status: 'offline' }, { status: 'offline' }, { status: 'offline' }, { status: 'offline' },
    ]);
    const seen: string[] = [];
    services.events.on((e) => {
      if (e.type === 'room:updated') seen.push(e.data.id);
    });

    services.scheduler.start();
    await waitFor(() => seen.filter((id) => id === r1.id).length === 2 && seen.filter((id) => id === r2.id).length === 2);

    await settle(clock, 30_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 4);
    expect(seen.filter((id) => id === r2.id)).toHaveLength(2);

    await settle(clock, 30_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 6);
    expect(seen.filter((id) => id === r2.id)).toHaveLength(2);

    await settle(clock, 60_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 8);
    expect(seen.filter((id) => id === r2.id)).toHaveLength(4);

    services.scheduler.stop();
  });

  it('skips rooms already being recorded', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sch-'));
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/3', displayName: 'LIVE' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
      { status: 'live', streamSessionId: 's2' },
    ]);

    services.scheduler.start();
    await settle(clock, 60_000);
    const rec = services.recordings.list().items[0]!;
    await waitFor(() => services.manager.isRoomActive(room.id) && services.recordings.get(rec.id)!.state === 'recording');
    expect(services.recordings.list().items).toHaveLength(1);

    await settle(clock, 60_000);
    await waitFor(() => services.recordings.list().items.length === 1);

    services.scheduler.stop();
  });

  it('triggerImmediateCheck marks restricted rooms failed with an alert', async () => {
    const { services } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 'R' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'restricted' }]);

    await services.scheduler.triggerImmediateCheck(room.id);
    const after = services.rooms.get(room.id)!;
    expect(after.monitorState).toBe('failed');
    expect(after.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    const alerts = services.alerts.list({ unresolvedOnly: true });
    expect(alerts[0]!.level).toBe('warning');
    expect(alerts[0]!.message).toContain('PLATFORM_ACCESS_RESTRICTED');
  });

  it('coalesces concurrent checks for the same room into one platform request', async () => {
    const { services } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/44', displayName: 'single-flight' });
    let checks = 0;
    let release: (() => void) | undefined;
    const adapter: PlatformAdapter = {
      platform: 'bilibili',
      async checkLiveStatus() {
        checks += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: 'offline' };
      },
      async getStreamUrl() {
        return { url: 'https://x/flv', format: 'flv', actualQuality: 'original' };
      },
      normalizeUrl: (u) => u,
      validateUrl: () => true,
    };
    services.adapterFor = () => adapter;

    const first = services.scheduler.triggerImmediateCheck(room.id);
    const second = services.scheduler.triggerImmediateCheck(room.id);
    await waitFor(() => checks === 1);
    release?.();
    await Promise.all([first, second]);

    expect(checks).toBe(1);
  });

  it('does not throw when a live room fails to start (getStreamUrl error) and records failed state', async () => {
    const { services } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/5', displayName: 'E' });
    const throwing: PlatformAdapter = {
      platform: 'bilibili',
      async checkLiveStatus() {
        return { status: 'live', streamSessionId: 's1' };
      },
      async getStreamUrl() {
        throw new Error('upstream down');
      },
      normalizeUrl: (u) => u,
      validateUrl: () => true,
    };
    services.adapterFor = () => throwing;

    await expect(services.scheduler.triggerImmediateCheck(room.id)).resolves.toBeUndefined();
    const after = services.rooms.get(room.id)!;
    expect(after.monitorState).toBe('failed');
    expect(after.lastError?.code).toBe('RECORDING_START_FAILED');
    expect(services.alerts.list().some((a) => a.message.includes('RECORDING_START_FAILED'))).toBe(true);
  });

  it('passes the configured douyin cookie to the adapter on check', async () => {
    const { services } = newServices();
    await services.secretStore.set('douyin.cookie', 'sessionid=abc');
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/6', displayName: 'C' });
    let seenCookie: string | undefined;
    const spy: PlatformAdapter = {
      platform: 'douyin',
      async checkLiveStatus(_url, cookie) {
        seenCookie = cookie;
        return { status: 'offline' };
      },
      async getStreamUrl() {
        return { url: 'https://x/flv', format: 'flv', actualQuality: 'original' };
      },
      normalizeUrl: (u) => u,
      validateUrl: () => true,
    };
    services.adapterFor = () => spy;

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(seenCookie).toBe('sessionid=abc');

    await services.secretStore.delete('douyin.cookie');
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(seenCookie).toBeUndefined();
  });
});
