import { statSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import type { PreviewSink } from '../../src/core/recorder-manager.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import { buildMinimalFlv, FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import { FakeRecordingEngine, type FakeEngineScript } from '../../src/recorder/fake-engine.js';
import type { RecordingEngine } from '../../src/recorder/engine.js';
import { FakeDiskGuard } from '../../src/storage/disk-guard.js';
import type { AppSettings } from '../../src/types/index.js';

function baseSettings(dir: string): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: 'original',
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: { enabled: true, host: 'smtp.x.com', port: 465, secure: true, username: 'u', from: 'f', recipients: ['a@b.c'] },
    dedupeWindowMinutes: 30,
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
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

/**
 * Advance both the application's clock and the event loop until an async
 * state transition completes. A real-time poll alone cannot trigger retry
 * timers backed by FakeClock, which made this test race on slower runners.
 */
async function waitForWithClock(clock: FakeClock, fn: () => boolean, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fn()) return;
    await settle(clock, 500);
  }
  throw new Error('waitForWithClock timeout');
}

class FakePreview implements PreviewSink {
  frames = new Map<string, number>();
  closed: { roomId: string; code: number; reason?: 'ended' | 'stream_lost' }[] = [];
  resets: string[] = [];
  canAccept(): boolean {
    return true;
  }
  hasClients(): boolean {
    return true;
  }
  broadcastFrame(roomId: string): void {
    this.frames.set(roomId, (this.frames.get(roomId) ?? 0) + 1);
  }
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void {
    this.closed.push({ roomId, code, reason });
  }
  resetRoom(roomId: string): void {
    this.resets.push(roomId);
  }
  recordingBootstrap(): Buffer {
    return buildMinimalFlv();
  }
}

function engineOf(services: Services): FakeRecordingEngine {
  return services.engineFor() as FakeRecordingEngine;
}

describe('RecorderManager', () => {
  it('records a live stream to completion, forwards preview frames and closes with 1000', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'offline' },
    ]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/10', displayName: '主播X' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1', streamTitle: 'T1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === 'recording');
    expect(rec.filePath).toBeNull();
    const withPath = services.recordings.get(rec.id)!;
    expect(withPath.filePath?.startsWith(path.join(dir, 'bilibili') + path.sep)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');

    for (let i = 0; i < 40 && services.recordings.get(rec.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(rec.id)!.state === 'completed');
    const done = services.recordings.get(rec.id)!;
    expect(done.state).toBe('completed');
    expect(done.fileSizeBytes).toBeGreaterThan(13);
    // 自然结束后 handleNaturalEnd 需等待短暂退避再确认下播，最终收口为 completed。
    for (let i = 0; i < 20 && services.rooms.get(room.id)!.monitorState !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    expect(services.rooms.get(room.id)!.monitorState).toBe('completed');
    expect(preview.frames.get(room.id)! >= 1).toBe(true);
    expect(preview.closed).toContainEqual({ roomId: room.id, code: 1000, reason: 'ended' });
  });

  it('does not emit recording:updated every second during recording (perf: 前端本地时长 ticker 替代，FE 采纳 #165 性能建议③)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-tick-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9', displayName: 'Ticker' });

    let recordingUpdates = 0;
    services.events.on((e) => {
      if (e.type === 'recording:updated' && e.data.state === 'recording') recordingUpdates += 1;
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: 't1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === 'recording');
    const atStart = recordingUpdates;
    expect(atStart).toBeGreaterThanOrEqual(1); // file_created 补发

    // 录制期间推进 3 秒：不应再有每秒周期补发（后端 ticker 已移除，时长由前端本地 ticker 走时）。
    await settle(clock, 1000);
    await settle(clock, 1000);
    await settle(clock, 1000);
    expect(recordingUpdates).toBe(atStart);

    // 结束后仍无多余事件。
    for (let i = 0; i < 20 && services.recordings.get(rec.id)!.state !== 'completed'; i += 1) await settle(clock, 500);
    await waitFor(() => services.recordings.get(rec.id)!.state === 'completed');
    expect(recordingUpdates).toBe(atStart);
  });

  it('resets the preview header buffer at each new recording session so a fresh FLV header is captured (#150 跨录制不残留旧头)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-reset-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/8', displayName: 'Reset' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 'r1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === 'recording');
    // 每个新录制会话开始（runSession）都会清空预览头缓冲，确保下一段流的 FLV 头被重新捕获。
    expect(preview.resets).toContain(room.id);
  });

  it('keeps the preview stream open while recording starts and stops', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-handoff-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/81', displayName: 'Handoff' });
    services.rooms.setLiveStatus(room.id, 'live');

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));
    await services.manager.maybeStartRecording(room, { streamSessionId: 'handoff-1' }, { manual: true });

    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(preview.closed).toEqual([]);
    expect(preview.resets).not.toContain(room.id);

    await services.manager.stopRecording(room.id);
    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(preview.closed).toEqual([]);
  });

  it('keeps a shared recording running when its last preview client closes', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-close-recording-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/82', displayName: 'Close while recording' });
    services.rooms.setLiveStatus(room.id, 'live');

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));
    await services.manager.maybeStartRecording(room, { streamSessionId: 'close-while-recording' }, { manual: true });
    expect(services.manager.isRoomActive(room.id)).toBe(true);

    // 与最后一个预览 WebSocket 断开时 server.ts 调用的路径一致。
    await services.manager.stopPreviewStream(room.id);

    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
  });

  it('marks a 0-byte recording as failed and removes the empty file, not completed (#165 空文件)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-empty-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    // 自定义引擎：file_created 后立即 completed(fileSize 0)——模拟取流无数据。
    const emptyEngine: RecordingEngine = {
      stop: async () => undefined,
      async *start(input, outputPath) {
        yield { type: 'file_created', filePath: outputPath ?? '' };
        yield { type: 'completed', fileSize: 0 };
      },
    };
    services.engineFor = () => emptyEngine as never;
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'offline' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/77', displayName: 'Empty' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 'e1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    for (let i = 0; i < 40 && services.recordings.get(rec.id)!.state !== 'failed'; i += 1) await settle(clock, 1000);
    const after = services.recordings.get(rec.id)!;
    expect(after.state).toBe('failed');
    expect(after.failureReason?.code).toBe('RECORDING_EMPTY');
    expect(services.rooms.get(room.id)!.monitorState).toBe('failed');
  });

  it('enforces maxConcurrentRecordings and raises CONCURRENT_LIMIT_REACHED', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6c-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1' },
      { status: 'live', streamSessionId: 's2' },
      { status: 'live', streamSessionId: 's3' },
    ]);
    const r1 = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/11', displayName: 'A' });
    const r2 = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/12', displayName: 'B' });
    const r3 = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/13', displayName: 'C' });

    services.scheduler.start();
    await settle(clock, 60_000);
    await waitFor(() => services.recordings.activeCount() === 2);

    expect(services.manager.activeRoomIds()).toHaveLength(2);
    expect(services.recordings.activeCount()).toBe(2);
    const r3State = services.rooms.get(r3.id)!;
    expect(r3State.monitorState).toBe('idle');
    expect(r3State.lastError?.code).toBe('CONCURRENT_LIMIT_REACHED');
    expect(services.alerts.list().some((a) => a.errorCode === 'CONCURRENT_LIMIT_REACHED')).toBe(true);
    expect(services.manager.isRoomActive(r1.id)).toBe(true);
    expect(services.manager.isRoomActive(r2.id)).toBe(true);
    services.scheduler.stop();
  });

  it('starts at most maxConcurrentRecordings when rooms go live concurrently', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6c-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const rooms = ['21', '22', '23'].map((num, index) =>
      services.rooms.create({ platform: 'bilibili', url: `https://live.bilibili.com/${num}`, displayName: `C${index + 1}` }),
    );

    // 调度器按 PLATFORM_CHECK_CONCURRENCY 并发检测房间，三个房间会在同一轮一起开播。
    // 额度判定必须发生在第一个 await 之前，否则三个房间会全部通过检查、并发数超过上限。
    const started = await Promise.all(
      rooms.map((room, index) => services.manager.maybeStartRecording(room, { streamSessionId: `c${index + 1}` })),
    );

    expect(started.filter(Boolean)).toHaveLength(2);
    expect(services.recordings.activeCount()).toBe(2);
    const denied = rooms
      .map((room) => services.rooms.get(room.id)!)
      .filter((room) => room.lastError?.code === 'CONCURRENT_LIMIT_REACHED');
    expect(denied).toHaveLength(1);
    expect(services.alerts.list().filter((alert) => alert.errorCode === 'CONCURRENT_LIMIT_REACHED')).toHaveLength(1);

    await Promise.all(rooms.map((room) => services.manager.stopRecording(room.id)));
  });

  it('dedupes by streamSessionId', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6d-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/14', displayName: 'D' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 1);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
  });

  it('treats "no data after 30s" as a retryable interruption instead of failing outright', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6p-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    services.engineFor = () => ({
      async *start(): AsyncGenerator<never, void> {
        await new Promise(() => {});
      },
      stop: async () => {},
    });
    // 一直开播：让重试持续进行，直到额度耗尽（脚本耗尽后回落 live）。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/15', displayName: 'P' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await waitFor(() => services.rooms.get(room.id)!.monitorState === 'recording');
    expect(services.recordings.list({ roomId: room.id }).items[0]!.state).toBe('pending');

    // 30 秒拿不到数据 → 进入重试，而不是一次判死。
    await waitForWithClock(clock, () => services.recordings.list({ roomId: room.id }).items[0]!.state === 'reconnecting', 80);

    // 重试额度耗尽后才收尾；全程只有一条记录，不因为重试多出记录。
    await waitForWithClock(clock, () => services.recordings.list({ roomId: room.id }).items[0]!.state === 'failed', 500);
    const recs = services.recordings.list({ roomId: room.id }).items;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.failureReason?.code).toBe('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED');
    // 失败原因要带上真正的原因，而不是笼统的"次数已耗尽"。
    expect(recs[0]!.failureReason?.message).toContain('等待直播数据超时');
    expect(services.rooms.get(room.id)!.monitorState).toBe('failed');
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
  });

  it('reconnects into the same file: one recording, appended bytes, interruption noted on the row', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6r-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: { code: 'NETWORK_UNAVAILABLE', message: '拉流失败 HTTP 503', roomId: null, recordingId: null, occurredAt: 'x', retryable: true },
    };
    // 一直开播：让 5/15/45 三次退避重连都真的发生，最后才耗尽。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/16', displayName: 'R' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.filePath !== null);
    const filePath = services.recordings.get(rec.id)!.filePath!;

    // 重连耗尽但文件里有数据 → 收成"已完成 + 中途中断"，而不是把整条录制判失败。
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed', 300);
    const after = services.recordings.get(rec.id)!;
    // 关键回归：重连不再新开文件、不再新建记录。
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    expect(after.filePath).toBe(filePath);
    expect(after.endReason).toBe('interrupted');
    expect(after.fileSizeBytes).toBeGreaterThan(13);
    // 失败原因要带上真正的原因，而不是笼统的"次数已耗尽"。
    expect(after.failureReason?.code).toBe('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED');
    expect(after.failureReason?.message).toContain('网络中断');
    // 中断期间的缺失时长要累计到这条录制上。
    expect(after.missingMs).toBeGreaterThan(0);
    expect(services.rooms.get(room.id)!.monitorState).toBe('completed');
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
    // 续录是追加写入：整个文件里只应有一个 FLV 头。
    expect((await readFile(filePath)).toString('latin1').split('FLV').length - 1).toBe(1);
  });

  it('blocks recording and alerts when disk space is low', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6l-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    (services.diskGuard as FakeDiskGuard).setSpace({ freeBytes: 1024, totalBytes: 100 * 1024 ** 3 });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/17', displayName: 'L' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await waitFor(() => services.rooms.get(room.id)!.monitorState === 'idle');
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.rooms.get(room.id)!.lastError?.code).toBe('DISK_SPACE_INSUFFICIENT');
    const mailer = services.mailer as FakeMailer;
    expect(mailer.sent.some((m) => m.subject.includes('磁盘空间不足'))).toBe(true);
    expect(services.alerts.list().some((a) => a.errorCode === 'DISK_SPACE_INSUFFICIENT')).toBe(true);
  });

  it('stopRecording completes the current segment with code 1000', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6s-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/18', displayName: 'S' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === 'recording');

    await services.manager.stopRecording(room.id);
    for (let i = 0; i < 10 && services.recordings.get(rec.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(rec.id)!.state === 'completed');
    expect(services.rooms.get(room.id)!.monitorState).toBe('completed');
    expect(preview.closed).toContainEqual({ roomId: room.id, code: 1000, reason: 'ended' });
  });

  it('manual re-check re-records the same broadcast after a manual stop (skips dedup)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6m-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/19', displayName: 'M' });

    // 第一次录制同一场（session s1），随后手动停止 → completed
    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const first = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(first.id)!.state === 'recording');
    await services.manager.stopRecording(room.id);
    for (let i = 0; i < 10 && services.recordings.get(first.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(first.id)!.state === 'completed');
    expect(services.manager.isRoomActive(room.id)).toBe(false);

    // 自动轮询（非手动）应被同场去重，不再重复录制
    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);

    // 手动再次检测应跳过去重、重新录制同一场
    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' }, { manual: true });
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 2);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(2);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
  });

  it('continues into the same file on natural end while still live (#43)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6n-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    // 自然结束后一直开播 → 立即接着录，无需等调度器（脚本耗尽后回落 live）。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/20', displayName: 'N' });

    const states: string[] = [];
    services.events.on((e) => {
      if (e.type === 'recording:updated' && e.data.roomId === room.id) states.push(e.data.state);
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.filePath !== null);
    const filePath = services.recordings.get(rec.id)!.filePath!;
    const flvLen = buildMinimalFlv().length;
    const segmentBytes = flvLen + 5 * (flvLen - 9);

    // 自然结束后继续录同一场：同一个文件继续变大，记录数始终是 1（不再每段一条记录 + 一个文件）。
    for (let i = 0; i < 60 && (await stat(filePath)).size <= segmentBytes; i += 1) await settle(clock, 500);
    expect((await stat(filePath)).size).toBeGreaterThan(segmentBytes);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    // 续录不再清空预览头缓冲：续录段跳过 FLV 头，清了之后中途加入的预览就永远等不到初始化段。
    expect(preview.resets.filter((id) => id === room.id)).toHaveLength(1);

    // 中途不能出现"已完成"后又回到录制中——那会让用户在录制过程中收到一次"录制完成"提示。
    const firstCompleted = states.indexOf('completed');
    if (firstCompleted !== -1) {
      expect(states.slice(firstCompleted + 1).some((s) => s === 'recording' || s === 'reconnecting')).toBe(false);
    }

    await services.manager.stopRecording(room.id);
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed');
    expect(services.recordings.get(rec.id)!.endReason).toBe('stopped');
    // 追加写入：整个文件里只有一个 FLV 头。
    expect((await readFile(filePath)).toString('latin1').split('FLV').length - 1).toBe(1);
  });

  it('rejects start when the save directory is unusable and never counts it as active (直播墙/预览点录制计数虚增回归)', async () => {
    const clock = new FakeClock();
    const base = await mkdtemp(path.join(tmpdir(), 'lr-baddir-'));
    // 用一个文件占用目录位置：mkdir 必然失败，且与权限无关（跨平台确定）。
    const blocker = path.join(base, 'not-a-directory');
    await writeFile(blocker, 'x');

    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(path.join(blocker, 'recordings')));
    (services.diskGuard as FakeDiskGuard).setSpace({ freeBytes: 1e12, totalBytes: 2e12 });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 's-baddir', streamTitle: 'T' }]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/9100', displayName: 'BadDir' });

    for (let i = 0; i < 3; i += 1) {
      // 每次点击都必须明确报错，并且不能留下 pending 记录——
      // 否则「录制中」计数逐个累加，最终占满并发名额导致再也无法录制。
      await expect(services.manager.maybeStartRecording(room, { streamSessionId: 's-baddir' })).rejects.toMatchObject({
        code: 'RECORDING_DIRECTORY_INVALID',
        message: '保存目录无效，录制失败',
      });
      expect(services.recordings.activeCount()).toBe(0);
    }
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });

  it('enqueues post-processing once for the merged recording (mp4_after/上传 收尾)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-mp4-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save({
      ...baseSettings(dir),
      recordingFormat: 'mp4_after',
      openlist: { enabled: true, serverUrl: 'https://dav.example.com/dav', directoryTemplate: '{room}', username: 'u' },
    } as AppSettings);
    await services.secretStore.set('openlist.token', 'tok');
    services.manager.preview = new FakePreview();
    // 一直开播 → 自然结束后同文件续录（不新增记录）。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/21', displayName: 'P' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.filePath !== null);
    const filePath = services.recordings.get(rec.id)!.filePath!;
    const flvLen = buildMinimalFlv().length;
    const segmentBytes = flvLen + 5 * (flvLen - 9);
    // 等续录真的发生（同一个文件被追加了第二段数据）。
    for (let i = 0; i < 60 && (await stat(filePath)).size <= segmentBytes; i += 1) await settle(clock, 500);

    await services.manager.stopRecording(room.id);
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed');
    // 合并成一个文件后，后处理/上传只针对这一条录制入队一次。
    await waitForWithClock(clock, () => services.uploader.uploadRepo.jobForRecording(rec.id) !== null);
    expect(services.uploader.uploadRepo.jobForRecording(rec.id)).not.toBeNull();
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
  });

  it('times out and retries when the stream opens but never sends data (HTTP 200 后卡住不吐字节)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-stall-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    // 只发 file_created、之后永不出数据：平台返回 200 后卡住的典型形态。
    const stalledEngine: RecordingEngine = {
      stop: async () => undefined,
      async *start(_input, outputPath) {
        yield { type: 'file_created', filePath: outputPath ?? '' };
        await new Promise(() => {});
      },
    };
    services.engineFor = () => stalledEngine as never;
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/40', displayName: 'Stall' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'recording');

    // 回归：file_created 不能撤销启动超时。否则这种情况会一直挂在"录制中"，占着并发名额且永不告警。
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'reconnecting', 100);
  });

  it('finishes the recording when the user stops during the retry backoff instead of wedging the room', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-stop-backoff-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: { code: 'NETWORK_UNAVAILABLE', message: '拉流失败', roomId: null, recordingId: null, occurredAt: 'x', retryable: true },
    };
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/41', displayName: 'StopBackoff' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'reconnecting');

    // 退避期间点停止：必须收尾并释放会话，否则记录永远停在"重连中"、并发名额不释放、停止请求一直挂着。
    const stopping = services.manager.stopRecording(room.id);
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.state === 'completed');
    await stopping;
    expect(services.recordings.get(rec.id)!.endReason).toBe('stopped');
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.recordings.activeCount()).toBe(0);
  });

  it('stops the pull and flushes the file on shutdown, leaving the record to startup recovery', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-shutdown-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/50', displayName: 'Shutdown' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(clock, () => services.recordings.get(rec.id)!.filePath !== null);
    const filePath = services.recordings.get(rec.id)!.filePath!;
    for (let i = 0; i < 40 && (statSync(filePath, { throwIfNoEntry: false })?.size ?? 0) <= 13; i += 1) {
      await settle(clock, 500);
    }

    // 退出：必须立刻返回（不能被拉流卡住），并且拉流真的停了。
    await services.manager.shutdown();
    const sizeAtExit = statSync(filePath).size;
    await settle(clock, 5_000);
    expect(statSync(filePath).size).toBe(sizeAtExit);
    expect(sizeAtExit).toBeGreaterThan(13);
    // 记录状态不在这里改：交给下次启动的恢复流程统一收口（服务重启中断 + 补跑收尾）。
    expect(services.recordings.get(rec.id)!.state).toBe('recording');
  });

  it('re-records the same broadcast after a network interruption, but not after a service restart', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-dedupe-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/30', displayName: 'Dedupe' });

    // 网络中断收尾：有数据、标 interrupted。
    const interrupted = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'same-session', streamTitle: 'T' });
    services.recordings.update(interrupted.id, { state: 'completed', endReason: 'interrupted' });

    // 主播还在播：同一场必须还能再录，否则网络恢复后剩下的直播永远不会被录。
    await services.manager.maybeStartRecording(room, { streamSessionId: 'same-session' });
    await waitForWithClock(clock, () => services.recordings.list({ roomId: room.id }).items.length === 2);
    await services.manager.stopRecording(room.id);
    await waitForWithClock(clock, () => !services.manager.isRoomActive(room.id));

    // 服务重启中断：不算"没录过"，同一场被去重挡住（不自动续录）。
    const restarted = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'restart-session', streamTitle: 'T' });
    services.recordings.update(restarted.id, { state: 'completed', endReason: 'service_restart' });
    const beforeRestart = services.recordings.list({ roomId: room.id }).items.length;
    await services.manager.maybeStartRecording(room, { streamSessionId: 'restart-session' });
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(beforeRestart);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });
});
