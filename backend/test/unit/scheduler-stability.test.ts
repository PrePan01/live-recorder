import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import type { Platform } from '../../src/types/index.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';

const opened: Services[] = [];
afterEach(async () => {
  for (const services of opened.splice(0)) {
    services.scheduler.stop();
    services.quality.stop();
    await services.manager.shutdown();
    services.db.close();
  }
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
};
function setup(platform: Platform, count: number, interval = 60) {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ':memory:', clock });
  opened.push(services);
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), autoRecord: false });
  const rooms = Array.from({ length: count }, (_, i) => services.rooms.create({
    platform, url: `https://example.com/${platform}/${i}`, displayName: `Room ${i}`, checkIntervalSec: interval,
  }));
  const check = vi.spyOn(services.adapterFor(platform), 'checkLiveStatus').mockResolvedValue({ status: 'offline' });
  const advance = async (ms: number) => { clock.advance(ms); await settle(); };
  return { services, clock, rooms, check, advance };
}
const failure = {
  status: 'error' as const,
  error: { code: 'PLATFORM_SERVER_ERROR', message: 'throttled', roomId: null, recordingId: null,
    occurredAt: '2026-08-28T00:00:00.000Z', retryable: true },
};
type Status = Awaited<ReturnType<PlatformAdapter['checkLiveStatus']>>;

describe('scheduler stability', () => {
  it('retries missing recording covers after a minute, then refreshes every five minutes via SSE', async () => {
    const { services, rooms, check, advance } = setup('bilibili', 1, 1);
    const room = rooms[0]!;
    vi.spyOn(services.manager, 'isRoomActive').mockImplementation(id => id === room.id);
    const start = vi.spyOn(services.manager, 'maybeStartRecording');
    const covers: Array<string | null | undefined> = [];
    services.events.on(event => {
      if (event.type === 'room:updated' && event.data.id === room.id) covers.push(event.data.liveCoverUrl);
    });
    check.mockResolvedValue({ status: 'live' });
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(services.rooms.get(room.id)?.liveCoverUrl).toBeNull();
    await advance(59_999);
    expect(check).toHaveBeenCalledTimes(1);
    const first = 'https://i0.hdslb.com/first.png';
    check.mockResolvedValue({ status: 'live', liveCoverUrl: first });
    await advance(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(services.rooms.get(room.id)?.liveCoverUrl).toBe(first);
    expect(covers).toContain(first);
    expect(services.scheduler.detectionLoadSnapshot().perMinute).toBe(1);
    await advance(299_999);
    expect(check).toHaveBeenCalledTimes(2);
    const second = 'https://i0.hdslb.com/second.png';
    check.mockResolvedValue({ status: 'live', liveCoverUrl: second });
    await advance(1);
    expect(check).toHaveBeenCalledTimes(3);
    expect(services.rooms.get(room.id)?.liveCoverUrl).toBe(second);
    expect(covers).toContain(second);
    check.mockResolvedValue({ status: 'live' });
    await advance(300_000);
    expect(check).toHaveBeenCalledTimes(4);
    expect(services.rooms.get(room.id)?.liveCoverUrl).toBe(second);
    expect(services.rooms.get(room.id)?.monitorState).toBe('recording');
    expect(start).not.toHaveBeenCalled();
  });

  it('refreshes manually recording disabled rooms and resumes their ordinary policy after recording stops', async () => {
    const { services, rooms, check, advance } = setup('youtube', 1, 10);
    const room = rooms[0]!;
    let active = true;
    vi.spyOn(services.manager, 'isRoomActive').mockImplementation(id => id === room.id && active);
    services.rooms.update(room.id, { enabled: false });
    check.mockResolvedValue({ status: 'live' });
    services.scheduler.start();
    await settle();
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    active = false;
    services.events.emit({ type: 'room:updated', data: services.rooms.get(room.id)! });
    await advance(300_000);
    expect(check).toHaveBeenCalledTimes(2);
    services.events.emit({ type: 'room:updated', data: services.rooms.update(room.id, { enabled: true }) });
    await advance(1);
    expect(check).toHaveBeenCalledTimes(3);
    await advance(10_000);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('deduplicates manual checks with recording refreshes and preserves recording state on failures and offline results', async () => {
    const { services, rooms, check, advance } = setup('bilibili', 1);
    const room = rooms[0]!;
    vi.spyOn(services.manager, 'isRoomActive').mockImplementation(id => id === room.id);
    const start = vi.spyOn(services.manager, 'maybeStartRecording');
    check.mockResolvedValue({ status: 'live' });
    services.scheduler.start();
    await settle();
    let release!: (status: Status) => void;
    check.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const manual = services.scheduler.triggerImmediateCheck(room.id);
    await settle();
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    release(failure);
    await manual;
    await settle();
    expect(services.rooms.get(room.id)?.monitorState).toBe('recording');
    check.mockResolvedValue({ status: 'offline' });
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(services.rooms.get(room.id)?.monitorState).toBe('recording');
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps pending staggered deadlines after another room finishes and after rescheduling', async () => {
    const { services, check, advance } = setup('xiaohongshu', 3);
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(3);
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(4);
    services.scheduler.reschedule();
    await advance(1_999);
    expect(check).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(5);
    await advance(1_999);
    expect(check).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(6);
    // Every room is eventually polled again; reservations do not starve the tail.
    for (const room of services.rooms.list()) {
      expect(check.mock.calls.filter(([url]) => url === room.url)).toHaveLength(2);
    }
  });

  it('stretches real polling deadlines under load and restores them when load drops', async () => {
    const { services, check, rooms, advance } = setup('bilibili', 3, 1);
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(3);
    await advance(1_499);
    expect(check).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(6);
    services.events.emit({ type: 'room:updated', data: services.rooms.update(rooms[2]!.id, { enabled: false }) });
    await advance(1_000);
    expect(check).toHaveBeenCalledTimes(8);
  });

  it('stops queued work on throttle, ignores old successes, and keeps other platforms running', async () => {
    const { services, check, advance } = setup('bilibili', 9);
    const other = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/100', displayName: 'other' });
    const otherCheck = vi.spyOn(services.adapterFor(other.platform), 'checkLiveStatus').mockResolvedValue({ status: 'offline' });
    const releases: ((status: Status) => void)[] = [];
    check.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(6);
    releases[0]!(failure);
    await settle();
    releases[1]!({ status: 'offline' });
    await settle();
    // More errors from this same batch must not multiply the backoff exponent.
    for (const release of releases.slice(2)) release(failure);
    await settle();
    expect(check).toHaveBeenCalledTimes(6);
    await advance(29_999);
    expect(check).toHaveBeenCalledTimes(6);
    await services.scheduler.checkRoom(services.rooms.get(other.id)!);
    expect(otherCheck).toHaveBeenCalledTimes(2);
    check.mockResolvedValue({ status: 'offline' });
    await advance(5_001);
    expect(check).toHaveBeenCalledTimes(9);
    // Once recovered, the remaining rooms continue at ordinary deadlines.
    await advance(25_000);
    expect(check).toHaveBeenCalledTimes(15);
  });

  it('backs off exponentially on repeated failures and resets after recovery', async () => {
    const { services, check, advance } = setup('xiaohongshu', 1, 1);
    check.mockResolvedValue(failure);
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await advance(29_999);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(5_001);
    expect(check).toHaveBeenCalledTimes(2);
    await advance(59_999);
    expect(check).toHaveBeenCalledTimes(2);
    check.mockResolvedValue({ status: 'offline' });
    await advance(5_001);
    expect(check).toHaveBeenCalledTimes(3);
    check.mockResolvedValue(failure);
    await advance(1_000);
    expect(check).toHaveBeenCalledTimes(4);
    check.mockResolvedValue({ status: 'offline' });
    await advance(35_000);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('loads settings a bounded number of times when scheduling many rooms', async () => {
    const { services } = setup('bilibili', 100);
    services.scheduler.start();
    await settle();
    const load = vi.spyOn(services.settings, 'load');
    services.scheduler.reschedule();
    // Three active platform timers: at most two reads each, independent of room count.
    expect(load.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('retains unstarted scheduled checks when a platform batch is interrupted', async () => {
    const { services, rooms, check, advance } = setup('xiaohongshu', 3);
    for (const room of rooms) {
      const schedule = services.schedules.create({ roomId: room.id, daysOfWeek: [5], startTime: '00:00', timezone: 'local' });
      services.schedules.update(schedule.id, { nextRunAt: new Date(services.clock.now() - 1).toISOString() });
    }
    const scheduled = vi.spyOn(services.scheduler, 'checkRoom');
    check.mockResolvedValueOnce(failure);
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await advance(35_000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(scheduled.mock.calls.filter(([, opts]) => opts?.scheduled)).toHaveLength(3);
  });
});
