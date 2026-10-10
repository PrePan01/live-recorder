import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import type { AppSettings, ScheduleDay } from '../../src/types/index.js';
import { AppError } from '../../src/types/error.js';

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
    // Tests that use this helper exercise recording paths explicitly; the
    // product's first-use default is covered in config.test instead.
    autoRecord: true,
    checkIntervalSec: { default: 60, bilibili: 30, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
    mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    dedupeWindowMinutes: 30,
  };
}

describe('Scheduler', () => {
  it.each([false, true])('due plans start independently of automatic recording and prior manual stops (stopped=%s)', async (stopped) => {
    const { services, clock } = newServices();
    clock.advance(Date.now() - clock.now());
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-plan-start-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/598', displayName: '定时录制' });
    services.rooms.update(room.id, { autoRecord: false });
    const opening = new Date(clock.now() - 60_000).toISOString();
    services.rooms.setLiveStatus(room.id, 'live', opening);
    if (stopped) {
      services.rooms.setAutoRecordStopped(room.id, opening);
      const previous = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'same-live', quality: 'original' });
      services.recordings.update(previous.id, { state: 'completed', endedAt: services.clock.iso() });
    }
    const previousCount = services.recordings.list({ roomId: room.id }).items.length;
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 'same-live' }]);
    const plan = services.schedules.create({ roomId: room.id, daysOfWeek: [new Date(clock.now()).getDay() as ScheduleDay], startTime: '00:00', timezone: 'local' });
    services.schedules.update(plan.id, { nextRunAt: new Date(clock.now() - 1000).toISOString() });
    try {
      services.scheduler.start();
      await waitFor(() => services.manager.isRoomActive(room.id));
      expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(previousCount + 1);
      expect(services.recordings.list({ roomId: room.id }).items[0]!.origin).toBe('automatic');
      expect(Date.parse(services.schedules.get(plan.id)!.nextRunAt!)).toBeGreaterThan(clock.now());
      // 停止本次计划录制后，普通轮询不能再次启动同一场直播。
      services.scheduler.stop();
      await services.manager.stopRecording(room.id);
      await services.scheduler.checkRoom(services.rooms.get(room.id)!);
      expect(services.manager.isRoomActive(room.id)).toBe(false);
      expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(previousCount + 1);
    } finally {
      services.scheduler.stop();
      await services.manager.shutdown();
    }
  });

  it('merges repeated enabled-room checks while a batch is still running', async () => {
    const { services } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    services.rooms.create({
      platform: 'bilibili',
      url: 'https://live.bilibili.com/599',
      displayName: '队列合并',
    });
    const adapter = services.adapterFor('bilibili');
    let release!: () => void;
    adapter.checkLiveStatus = async () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 'offline' });
      });

    expect(services.scheduler.queueEnabledRoomChecks()).toEqual({
      queued: 1,
      alreadyRunning: false,
    });
    expect(services.scheduler.queueEnabledRoomChecks()).toEqual({
      queued: 0,
      alreadyRunning: true,
    });
    await waitFor(() => typeof release === 'function');
    release();
    await waitFor(() => !services.scheduler.isChecking);
    expect(services.scheduler.queueEnabledRoomChecks()).toEqual({
      queued: 1,
      alreadyRunning: false,
    });
  });

  it('stores the detected live room title and clears it once the room goes offline', async () => {
    const { services } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/600', displayName: '主播A' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamTitle: '这是当前直播间标题，不是主播名字' },
      { status: 'offline' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.currentStreamTitle).toBe('这是当前直播间标题，不是主播名字');

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.currentStreamTitle).toBeNull();
  });

  /**
   * 监控卡片要在录制前说明「这个房间最高能录到什么」。离线时必须清空，
   * 否则会把上一场的档位当成当前状态展示（未登录 B站 时尤其误导）。
   */
  it('stores the qualities the room can actually record and clears them once offline', async () => {
    const { services } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/601', displayName: '主播B' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', availableQualities: ['720p'] },
      { status: 'offline' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.availableQualities).toEqual(['720p']);

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.availableQualities).toEqual([]);
  });

  it('emits one live-started event only for an offline-to-live transition with all notification gates enabled', async () => {
    const { services } = newServices();
    services.settings.save({
      ...baseSettings(),
      autoRecord: false,
      mail: { enabled: true, host: 'smtp.x.com', port: 465, secure: true, username: 'u', from: 'u@x.com', recipients: ['me@x.com'] },
      notifications: { desktopEnabled: true, liveStarted: true, recordingStarted: true, recordingEnded: false, recordingFailed: true, diskSpaceLow: true, uploadFailed: true, dedupeWindowMinutes: 30 },
    });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/601', displayName: '主播A', liveNotificationEnabled: true });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }, { status: 'live' }, { status: 'live' }]);
    const notices: Array<{ title: string; body: string }> = [];
    services.events.on((event) => {
      if (event.type === 'desktop:notification') notices.push(event.data);
    });

    await services.scheduler.triggerImmediateCheck(room.id);
    await services.scheduler.triggerImmediateCheck(room.id);
    await services.scheduler.triggerImmediateCheck(room.id);

    expect(notices).toEqual([{ title: 'Live Recorder提醒', body: '您订阅的 主播A 已开播' }]);
    const mailer = services.mailer as FakeMailer;
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe('[直播录制助手] 您订阅的 主播A 已开播');
    expect(services.liveEvents.list(room.id, '2000-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('does not announce an initially-live room or bypass disabled notification gates', async () => {
    const { services } = newServices();
    services.settings.save({
      ...baseSettings(),
      autoRecord: false,
      notifications: { desktopEnabled: false, liveStarted: true, recordingStarted: true, recordingEnded: false, recordingFailed: true, diskSpaceLow: true, uploadFailed: true, dedupeWindowMinutes: 30 },
    });
    const initiallyLive = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/602', displayName: '首次开播', liveNotificationEnabled: true });
    const gated = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/603', displayName: '总开关关闭', liveNotificationEnabled: true });
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    adapter.setScript([{ status: 'live' }, { status: 'offline' }, { status: 'live' }]);
    const notices: string[] = [];
    services.events.on((event) => { if (event.type === 'desktop:notification') notices.push(event.data.body); });

    await services.scheduler.triggerImmediateCheck(initiallyLive.id);
    await services.scheduler.triggerImmediateCheck(gated.id);
    await services.scheduler.triggerImmediateCheck(gated.id);

    expect(notices).toEqual([]);
  });

  it('persists initial-live discovery separately from an offline-to-live transition', async () => {
    const { services, clock } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/604', displayName: '首次发现' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live' }, { status: 'offline' }, { status: 'live' }]);

    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_000);
    await services.scheduler.triggerImmediateCheck(room.id);

    const events = services.liveEvents.list(room.id, '2000-01-01T00:00:00.000Z');
    expect(events.map((event) => event.source)).toEqual(['initial_live', 'transition']);
    expect(events[0]!.lowerBoundAt).toBe(room.createdAt);
    expect(events[1]!.lowerBoundAt).toBeTruthy();
  });

  it('uses a platform-reported start time once without duplicating an ongoing broadcast', async () => {
    const { services } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/605', displayName: '平台时间' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', platformStartedAt: '2026-08-28T00:00:00.000Z' },
      { status: 'live', platformStartedAt: '2026-08-28T00:00:00.000Z' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    await services.scheduler.triggerImmediateCheck(room.id);

    const events = services.liveEvents.list(room.id, '2000-01-01T00:00:00.000Z');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'platform', platformStartedAt: '2026-08-28T00:00:00.000Z' });
  });

  it('checks with the enabled autoRecord setting after an older check finishes', async () => {
    const { services } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-auto-pending-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/90', displayName: 'Pending' });
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    adapter.checkLiveStatus = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { status: 'live', streamSessionId: 'pending-session' };
    };
    const pending = services.scheduler.triggerImmediateCheck(room.id);
    await waitFor(() => calls === 1);
    services.rooms.update(room.id, { autoRecord: true });
    const enabling = services.scheduler.triggerAutoRecordCheck(room.id);
    release();
    try {
      await Promise.all([pending, enabling]);
      expect(calls).toBe(2);
      expect(services.manager.isRoomActive(room.id)).toBe(true);
      expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    } finally {
      await services.manager.stopRecording(room.id);
    }
  });

  it('keeps a due schedule claimed by one platform timer until the other platform consumes it', () => {
    const { services } = newServices();
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/99', displayName: 'D' });
    const schedule = services.schedules.create({ roomId: room.id, daysOfWeek: [6], startTime: '10:00', timezone: 'local' });
    const dueAt = new Date('2026-08-29T10:00:00.000Z').getTime();
    services.schedules.update(schedule.id, { nextRunAt: new Date(dueAt).toISOString() });

    // In production each platform timer captures its own Date.now(), so these
    // calls deliberately use different values. The Bilibili timer claims all
    // due schedules first; it must not discard the Douyin item.
    const scheduler = services.scheduler as unknown as { dueScheduleChecks(now: number, platform: 'bilibili' | 'douyin'): string[] };
    expect(scheduler.dueScheduleChecks(dueAt + 1, 'bilibili')).toEqual([]);
    expect(scheduler.dueScheduleChecks(dueAt + 2, 'douyin')).toEqual([room.id]);
  });

  it('persists adapter display names and emits updated rooms for Bilibili and Douyin (#91)', async () => {
    const { services } = newServices();
    const bilibili = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/91', displayName: '', autoRecord: false });
    const douyin = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/91', displayName: '', autoRecord: false });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 'b91', displayName: 'B站主播' },
    ]);
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 'd91', displayName: '抖音主播' },
    ]);
    const updates: Array<{ id: string; displayName: string }> = [];
    services.events.on((event) => {
      if (event.type === 'room:updated') updates.push({ id: event.data.id, displayName: event.data.displayName });
    });

    await services.scheduler.triggerImmediateCheck(bilibili.id);
    await services.scheduler.triggerImmediateCheck(douyin.id);

    expect(services.rooms.get(bilibili.id)!.displayName).toBe('B站主播');
    expect(services.rooms.get(douyin.id)!.displayName).toBe('抖音主播');
    expect(updates).toContainEqual({ id: bilibili.id, displayName: 'B站主播' });
    expect(updates).toContainEqual({ id: douyin.id, displayName: '抖音主播' });
  });

  it('checks each platform at its own interval and reschedules serially', async () => {
    const { services, clock } = newServices();
    // 本例只计调度器定时任务，健康采样使用同一可控时钟。
    services.quality.stop();
    services.settings.save(baseSettings());
    const r1 = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'B' });
    const r2 = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/2', displayName: 'D' });
    // 本例只测轮询间隔；默认脚本第二次变为 live 会启动录制并混入额外事件/计时器。
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([
      { status: 'offline' }, { status: 'offline' },
    ]);
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
    // room:updated 先于本轮检测收尾；两平台都重新挂好计时器后才能推进时钟。
    await waitFor(() => seen.filter((id) => id === r1.id).length === 2 && seen.filter((id) => id === r2.id).length === 2 && clock.pendingTimers() === 2);

    await settle(clock, 30_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 4 && clock.pendingTimers() === 2);
    expect(seen.filter((id) => id === r2.id)).toHaveLength(2);

    await settle(clock, 30_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 6 && clock.pendingTimers() === 2);
    expect(seen.filter((id) => id === r2.id)).toHaveLength(2);

    await settle(clock, 60_000);
    await waitFor(() => seen.filter((id) => id === r1.id).length === 8 && seen.filter((id) => id === r2.id).length === 4 && clock.pendingTimers() === 2);
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
    // 启动链路含真实磁盘 I/O（保存目录校验 + 建目录），记录可能晚于一次 settle 才出现，按状态等待。
    await waitFor(() => services.recordings.list().items.length === 1);
    const rec = services.recordings.list().items[0]!;
    await waitFor(() => services.manager.isRoomActive(room.id) && services.recordings.get(rec.id)!.state === 'recording');
    expect(services.recordings.list().items).toHaveLength(1);

    await settle(clock, 60_000);
    await waitFor(() => services.recordings.list().items.length === 1);

    services.scheduler.stop();
  });

  it('三票门·60s 独立计数：检测节奏快于 60s 时前两票仍各满 1 分钟', async () => {
    const { services, clock } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/88', displayName: 'fast' });
    const err = () =>
      (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
        { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试').toObject() },
      ]);
    // 35 秒一测的节奏连测 3 次：t0=票1、+35s 不计、+70s=票2 → 仍不足 3 票。
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(35_001);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(35_001);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.monitorState).not.toBe('failed');
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
    // 再满一个 60s 票距 → 票3 触发。
    clock.advance(60_001);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.monitorState).toBe('failed');
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(1);
  });

  it('三票门·换码重计：连续语义被不同错误打断，各码从零各算各账', async () => {
    const { services, clock } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/89', displayName: 'churncode' });
    const err = (code: string) =>
      (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
        { status: 'error', error: new AppError(code, `错误 ${code}`).toObject() },
      ]);
    // A×2（票距达标）→ B 打断（A 断连作废）→ B 攒满 3 票只报 B。
    err('PLATFORM_CHANGED');
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_001);
    err('PLATFORM_CHANGED');
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_001);
    err('CHECK_FAILED');
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_001);
    err('CHECK_FAILED');
    await services.scheduler.triggerImmediateCheck(room.id);
    // 此时 CHECK_FAILED 才 2 票（B 起点重计），不得上屏。
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
    clock.advance(60_001);
    err('CHECK_FAILED');
    await services.scheduler.triggerImmediateCheck(room.id);
    const alerts = services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.errorCode).toBe('CHECK_FAILED');
  });

  it('三票门·恢复清计数：成功检测后计数清零，之后同错从第 1 票重新数', async () => {
    const { services, clock } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/90', displayName: 'reset' });
    const err = () =>
      (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
        { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试').toObject() },
      ]);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    clock.advance(60_001);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    // 成功一轮（offline）→ 清票。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    await services.scheduler.triggerImmediateCheck(room.id);
    // 若票没清，此处再错 1 次就会凑满 3 票；清了则仍静默。
    clock.advance(60_001);
    err();
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.monitorState).not.toBe('failed');
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
  });

  it('triggerImmediateCheck marks restricted rooms failed with an alert only after 3 spaced votes（三票门）', async () => {
    const { services, clock } = newServices();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/4', displayName: 'R' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'restricted' },
      { status: 'restricted' },
      { status: 'restricted' },
    ]);

    // 第 1 票：完全静默（不标红、不进告警）。
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.monitorState).not.toBe('failed');
    expect(services.alerts.list({ unresolvedOnly: true })).toHaveLength(0);
    // 第 2 票（票距≥60s）仍静默。
    clock.advance(60_001);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.monitorState).not.toBe('failed');
    expect(services.alerts.list({ unresolvedOnly: true })).toHaveLength(0);
    // 第 3 票触发：卡片标红 + 进告警中心。
    clock.advance(60_001);
    await services.scheduler.triggerImmediateCheck(room.id);
    const after = services.rooms.get(room.id)!;
    expect(after.monitorState).toBe('failed');
    expect(after.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    const alerts = services.alerts.list({ unresolvedOnly: true });
    expect(alerts[0]!.level).toBe('warning');
    expect(alerts[0]!.errorCode).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(alerts[0]!.message).toBe('平台访问受限，请检查B站授权');
  });

  it('manual triggerImmediateCheck does not re-record the same broadcast after a manual stop', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-schm-'));
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/19', displayName: 'M' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    const first = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(first.id)!.state === 'recording');
    await services.manager.stopRecording(room.id);
    for (let i = 0; i < 10 && services.recordings.get(first.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(first.id)!.state === 'completed');

    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });

  it('does not stop an active recording when a live recheck reports offline (#64 revised)', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-schoff-'));
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/20', displayName: 'off' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
      { status: 'offline' },
    ]);

    // 首次检查 → 开播录制
    await services.scheduler.triggerImmediateCheck(room.id);
    await waitFor(() => services.manager.isRoomActive(room.id));
    // 推进时钟让引擎产出 file_created → 进入 recording 状态
    for (let i = 0; i < 10 && !services.recordings.list({ roomId: room.id }).items.some((r) => r.state === 'recording'); i += 1) {
      await settle(clock, 500);
    }
    expect(services.manager.isRoomActive(room.id)).toBe(true);

    // 第二次检查返回 offline：正在录制的房间不再由调度器停录（否则「打开应用时的一次检测」就会掐断录制，
    // 且这种系统停录会被记成用户手动停止）。是否结束交给录制器自己的存活判定。
    await services.scheduler.triggerImmediateCheck(room.id);
    for (let i = 0; i < 20; i += 1) {
      await settle(clock, 500);
    }
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    // 房态仍更新为已下播（卡片要展示），但不影响正在进行的录制。
    expect(services.rooms.get(room.id)!.lastLiveStatus).toBe('offline');

    await services.manager.stopRecording(room.id);
  });

  it('keeps an active recording visible after an immediate live recheck', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sch-recheck-'));
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/64', displayName: 'recheck' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    await waitFor(() => services.manager.isRoomActive(room.id));
    await settle(clock, 500);

    await services.scheduler.triggerImmediateCheck(room.id);

    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    expect(services.manager.enrichRoom(services.rooms.get(room.id)!).activeRecording).not.toBeNull();
  });

  it('keeps an active recording visible when an immediate recheck fails', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sch-recheck-error-'));
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/65', displayName: 'recheck error' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
      { status: 'restricted' },
      { status: 'restricted' },
      { status: 'restricted' },
    ]);

    await services.scheduler.triggerImmediateCheck(room.id);
    await waitFor(() => services.manager.isRoomActive(room.id));
    await settle(clock, 500);

    // 前 2 票静默：录制中的会话不挂错误（卡片完全不显示）。
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.lastError ?? null).toBeNull();
    clock.advance(60_001);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.rooms.get(room.id)!.lastError ?? null).toBeNull();
    // 第 3 票：按既有语义挂 lastError、状态保持 recording。
    clock.advance(60_001);
    await services.scheduler.triggerImmediateCheck(room.id);

    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    expect(services.rooms.get(room.id)!.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
  });

  it('autoRecord=false (global, room inherits) blocks auto-start AND manual /check (#63/#77 unified)', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-autorec-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/21', displayName: 'auto' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
    ]);

    // 自动调度检测（runPlatform 走 checkRoom 无 manual）→ 仅检测不自动录
    services.scheduler.start();
    await settle(clock, 1000);
    for (let i = 0; i < 10 && services.recordings.list({ roomId: room.id }).items.length !== 0; i += 1) {
      await settle(clock, 500);
    }
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.rooms.get(room.id)!.monitorState).toBe('idle');
    services.scheduler.stop();

    // 手动 /check（manual）→ 统一语义下也不自动开始（全局 false + 房间继承）
    await services.scheduler.triggerImmediateCheck(room.id);
    for (let i = 0; i < 10 && services.recordings.list({ roomId: room.id }).items.length !== 0; i += 1) {
      await settle(clock, 500);
    }
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.rooms.get(room.id)!.monitorState).toBe('idle');
  });

  it('room-level autoRecord overrides global false (#75)', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-roomauto-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/22', displayName: 'roomAuto' });
    // 房间单独覆盖 autoRecord=true（全局 false 但该房间仍自动录）
    services.rooms.update(room.id, { autoRecord: true });
    expect(services.rooms.get(room.id)!.autoRecord).toBe(true);
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
    ]);

    services.scheduler.start();
    await settle(clock, 1000);
    for (let i = 0; i < 10 && services.recordings.list({ roomId: room.id }).items.length === 0; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 1);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    services.scheduler.stop();
  });

  it('starts each offline-to-live cycle even when the platform reuses a stream session id, but not after a manual stop within that cycle', async () => {
    const { services, clock } = newServices();
    // RecordingRepository timestamps rows with wall-clock time; align the fake
    // scheduler clock so the persisted opening boundary is comparable.
    clock.advance(Date.now() - clock.now());
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-live-cycle-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/26', displayName: 'cycle' });
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    adapter.setScript([
      { status: 'offline' },
      { status: 'live', streamSessionId: 'reused-id' },
      { status: 'live', streamSessionId: 'reused-id' },
      { status: 'offline' },
      { status: 'live', streamSessionId: 'reused-id' },
    ]);

    await services.scheduler.checkRoom(room);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    await waitFor(() => services.manager.isRoomActive(room.id));
    await settle(clock, 500);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items[0]?.state === 'recording');
    await services.manager.stopRecording(room.id);
    for (let i = 0; i < 10 && services.manager.isRoomActive(room.id); i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => !services.manager.isRoomActive(room.id));

    // 用户本次直播手动停录后，后续 live 检测不能重新自动启动。
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);

    // 检测到下播，再次开播即进入新的周期；即使平台 session id 未变也必须开始录制。
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    clock.advance(60_000);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 2);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    await services.manager.stopRecording(room.id);
    await settle(clock, 200);
  });

  it('同场内平台更换 streamSessionId 也不得自动重开（手动停标记与 session id 解耦），下播清标记后恢复', async () => {
    const { services, clock } = newServices();
    clock.advance(Date.now() - clock.now());
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sess-churn-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/77', displayName: 'churn' });
    const adapter = services.adapterFor('bilibili') as FakePlatformAdapter;
    adapter.setScript([
      { status: 'offline' },
      { status: 'live', streamSessionId: 'id-a' },
      // 手动停止后：平台侧断点重推导致 session id 变化——仍属同一场，禁止自动重开。
      { status: 'live', streamSessionId: 'id-b' },
      { status: 'offline' },
      { status: 'live', streamSessionId: 'id-c' },
    ]);
    await services.scheduler.checkRoom(room);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    await waitFor(() => services.manager.isRoomActive(room.id));
    await settle(clock, 500);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items[0]?.state === 'recording');
    await services.manager.stopRecording(room.id);
    await waitFor(() => !services.manager.isRoomActive(room.id));
    // 标记已落库且同场 live 检测不重启（session id 换了也不重启）。
    expect(services.rooms.get(room.id)!.autoRecordStoppedSession).toBeTruthy();
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    // 下播：liveStartedAt 与标记一并清空。
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    expect(services.rooms.get(room.id)!.liveStartedAt).toBeNull();
    expect(services.rooms.get(room.id)!.autoRecordStoppedSession ?? null).toBeNull();
    // 新的未开播→开播沿：自动录制恢复。
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 2);
    await services.manager.stopRecording(room.id);
    await settle(clock, 200);
  });

  it('room autoRecord=false blocks even manual /check from auto-starting (PrePan)', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-roomoff-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/23', displayName: 'off' });
    services.rooms.update(room.id, { autoRecord: false });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1', streamTitle: 'T1' },
    ]);

    // 手动 /check 也不应自动开始录制（房间级明确关闭）
    await services.scheduler.triggerImmediateCheck(room.id);
    for (let i = 0; i < 10 && services.recordings.list({ roomId: room.id }).items.length !== 0; i += 1) {
      await settle(clock, 500);
    }
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.rooms.get(room.id)!.monitorState).toBe('idle');
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
    services.settings.save(baseSettings());
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
    expect(services.alerts.list().some((a) => a.errorCode === 'RECORDING_START_FAILED')).toBe(true);
  });

  it('does not leave a room stuck in checking when checkLiveStatus throws (DB 缺列/平台异常容错)', async () => {
    const { services } = newServices();
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/405783317287', displayName: '' });
    const throwing: PlatformAdapter = {
      platform: 'douyin',
      async checkLiveStatus() {
        throw new Error('no such column: title_source');
      },
      async getStreamUrl() {
        return { url: 'https://x/flv', format: 'flv', actualQuality: 'original' };
      },
      normalizeUrl: (u) => u,
      validateUrl: () => true,
    };
    services.adapterFor = () => throwing;

    await expect(services.scheduler.triggerImmediateCheck(room.id)).resolves.toBeUndefined();
    const after = services.rooms.get(room.id)!;
    // 不卡在 checking：落到 failed + lastError + 告警，下一轮检测可恢复。
    expect(after.monitorState).toBe('failed');
    expect(after.lastError?.code).toBe('CHECK_FAILED');
    expect(after.lastError?.message).toContain('no such column');
    expect(services.alerts.list().some((a) => a.errorCode === 'CHECK_FAILED')).toBe(true);
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

  it('marks every douyin room and skips further checks after an explicit cookie-expired response', async () => {
    const { services } = newServices();
    const first = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/71', displayName: 'first' });
    const second = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/72', displayName: 'second' });
    const bilibili = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/73', displayName: 'bilibili' });
    let calls = 0;
    const expiredAdapter: PlatformAdapter = {
      platform: 'douyin',
      async checkLiveStatus() {
        calls += 1;
        return {
          status: 'restricted',
          error: new AppError('DOUYIN_COOKIE_EXPIRED', '抖音授权已失效，请到设置页重新授权').toObject(),
        };
      },
      async getStreamUrl() {
        return { url: 'https://x/flv', format: 'flv', actualQuality: 'original' };
      },
      normalizeUrl: (url) => url,
      validateUrl: () => true,
    };
    services.adapterFor = () => expiredAdapter;

    await services.scheduler.triggerImmediateCheck(first.id);
    await services.scheduler.triggerImmediateCheck(second.id);

    expect(services.rooms.get(first.id)?.lastError?.code).toBe('DOUYIN_COOKIE_EXPIRED');
    expect(services.rooms.get(second.id)?.lastError?.code).toBe('DOUYIN_COOKIE_EXPIRED');
    expect(calls).toBe(1);
    expect(services.rooms.get(bilibili.id)?.lastError).toBeNull();
    expect(services.alerts.list().filter((alert) => alert.errorCode === 'DOUYIN_COOKIE_EXPIRED')).toHaveLength(1);
  });

  it('writes lastLiveStatus from check result (#78)', async () => {
    const { services, clock } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-livestatus-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/24', displayName: 'ls' });
    expect(services.rooms.get(room.id)!.lastLiveStatus).toBeNull();

    // 开播 → live
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 's1' }]);
    await services.scheduler.triggerImmediateCheck(room.id);
    for (let i = 0; i < 5 && !services.rooms.get(room.id)!.lastLiveStatus; i += 1) await settle(clock, 500);
    expect(services.rooms.get(room.id)!.lastLiveStatus).toBe('live');

    // 下播 → offline
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    await services.scheduler.triggerImmediateCheck(room.id);
    for (let i = 0; i < 5 && services.rooms.get(room.id)!.lastLiveStatus === 'live'; i += 1) await settle(clock, 500);
    expect(services.rooms.get(room.id)!.lastLiveStatus).toBe('offline');
  });

  it('treats an offline check as a normal not-live state: idle room and no alert (不刷"平台接口有变动")', async () => {
    const { services } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-offline-quiet-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/123456', displayName: 'quiet' });
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([{ status: 'offline' }]);

    await services.scheduler.triggerImmediateCheck(room.id);

    const after = services.rooms.get(room.id)!;
    expect(after.monitorState).toBe('idle');
    expect(after.lastLiveStatus).toBe('offline');
    expect(after.lastError).toBeNull();
    // 未开播不是异常：不该落任何告警（以前空响应会被判成 PLATFORM_CHANGED，每个检测周期刷一条）。
    expect(services.alerts.list().filter((a) => a.roomId === room.id)).toHaveLength(0);
  });

  it('检测恢复后自动收敛该房间未读的平台告警（过渡期一次误报不该长期挂榜）', async () => {
    const { services } = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-alert-resolve-'));
    services.settings.save({ ...baseSettings(dir), autoRecord: false });
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/123456', displayName: 'warn' });
    const updates: string[] = [];
    services.events.on((event) => {
      if (event.type === 'alert:updated') updates.push(event.data.id);
    });

    const failOnce = () =>
      (services.adapterFor('douyin') as FakePlatformAdapter).setScript([
        { status: 'error', error: new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试').toObject() },
      ]);
    const { clock } = { clock: (services as never as { clock: { advance(ms: number): void } }).clock };
    // 攒满 3 票（票距≥60s）才出告警。
    failOnce();
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
    clock.advance(60_001);
    failOnce();
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
    clock.advance(60_001);
    failOnce();
    await services.scheduler.triggerImmediateCheck(room.id);
    const unresolved = services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.errorCode).toBe('PLATFORM_CHANGED');

    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    await services.scheduler.triggerImmediateCheck(room.id);

    expect(services.alerts.list({ unresolvedOnly: true }).filter((a) => a.roomId === room.id)).toHaveLength(0);
    // 前端靠 alert:updated 更新已读状态，收敛时必须推送。
    expect(updates).toContain(unresolved[0]!.id);
  });

  it("检测顺带持久化主播头像：有值写入、结果缺失不清空（兼容历史），名称填补不回归", async () => {
    const { services } = newServices();
    services.settings.save({ ...baseSettings(), autoRecord: false });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/701', displayName: '' });
    // 迁移 v38 列就位：新房间头像默认 null（历史房间=同一形态，UI 按 null 兜底）
    expect(services.rooms.get(room.id)!.avatarUrl).toBeNull();

    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'offline', displayName: '自动识别名', avatarUrl: 'https://i0.hdslb.com/bfs/face/x.jpg' },
    ]);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    let r = services.rooms.get(room.id)!;
    expect(r.displayName).toBe('自动识别名');
    expect(r.avatarUrl).toBe('https://i0.hdslb.com/bfs/face/x.jpg');

    // 结果不带头像 → 不清空已有值；非空名称不被覆盖
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'offline', displayName: '另一个名字' },
    ]);
    await services.scheduler.checkRoom(services.rooms.get(room.id)!);
    r = services.rooms.get(room.id)!;
    expect(r.avatarUrl).toBe('https://i0.hdslb.com/bfs/face/x.jpg');
    expect(r.displayName).toBe('自动识别名');
  });

});
