import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import type { AppSettings } from '../../src/types/index.js';

const remuxFlvToMp4 = vi.hoisted(() => vi.fn(async (_flvPath: string): Promise<string | null> => null));
vi.mock('../../src/recorder/remux.js', () => ({
  remuxFlvToMp4,
  mp4PathFor: (p: string) => (/\.flv$/i.test(p) ? p.replace(/\.flv$/i, '.mp4') : null),
}));

function baseSettings(dir: string): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: 'original',
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    dedupeWindowMinutes: 30,
  } as AppSettings;
}

async function settle(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

async function waitForWithClock(clock: FakeClock, fn: () => boolean, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fn()) return;
    await settle(clock, 500);
  }
  throw new Error('waitForWithClock timeout');
}

describe('mp4_after 转封装失败的重试与告警', () => {
  it('首次 + 重试 2 次后不再重试，发告警且保留源 FLV 记录', async () => {
    remuxFlvToMp4.mockClear();
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-remux-retry-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save({ ...baseSettings(dir), recordingFormat: 'mp4_after' } as AppSettings);
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/31', displayName: 'R' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'recording');
    await services.manager.stopRecording(room.id);
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed');
    await waitForWithClock(clock, () => remuxFlvToMp4.mock.calls.length >= 3);
    // 重试用尽后再推进一段时间，确认不会继续重试。
    await settle(clock, 30_000);

    expect(remuxFlvToMp4).toHaveBeenCalledTimes(3);
    expect(services.alerts.list({ limit: 50 }).filter((a) => a.errorCode === 'RECORDING_REMUX_FAILED')).toHaveLength(1);
    // 转换失败不改 filePath：上传的仍是源 FLV，源文件不丢。
    expect(services.recordings.get(rec.id)!.filePath).toMatch(/\.flv$/);
  });

  it('自然断流结束时同样只收尾一次（不重复转封装、不重复告警）', async () => {
    remuxFlvToMp4.mockClear();
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-remux-natural-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save({ ...baseSettings(dir), recordingFormat: 'mp4_after' } as AppSettings);
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/32', displayName: 'R2' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    // 流自然结束 → 主播已下播 → 收口；这条路径过去会把收尾做两遍。
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed');
    await waitForWithClock(clock, () => remuxFlvToMp4.mock.calls.length >= 3);
    await settle(clock, 60_000);

    expect(remuxFlvToMp4).toHaveBeenCalledTimes(3);
    expect(services.alerts.list({ limit: 50 }).filter((a) => a.errorCode === 'RECORDING_REMUX_FAILED')).toHaveLength(1);
  });
});
