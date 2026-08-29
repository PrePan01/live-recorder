import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import type { PreviewSink } from '../../src/core/recorder-manager.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
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

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
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

class FakePreview implements PreviewSink {
  frames = new Map<string, number>();
  closed: { roomId: string; code: number; reason?: 'ended' | 'stream_lost' }[] = [];
  resets: string[] = [];
  canAccept(): boolean {
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
    expect(withPath.filePath).toMatch(new RegExp(`^${dir}/bilibili/`));
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
    const mailer = services.mailer as FakeMailer;
    expect(mailer.sent.some((m) => m.subject.includes('已开播'))).toBe(true);
  });

  it('emits recording:updated periodically while recording so live duration refreshes, and stops after end (#149)', async () => {
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

    // 录制期间（fake 引擎约 3s）推进 2 秒：ticker 应每秒补发。
    await settle(clock, 1000);
    await settle(clock, 1000);
    expect(recordingUpdates).toBeGreaterThanOrEqual(atStart + 1);

    // 结束后 ticker 停止：不再有 recording:updated。
    for (let i = 0; i < 20 && services.recordings.get(rec.id)!.state !== 'completed'; i += 1) await settle(clock, 500);
    await waitFor(() => services.recordings.get(rec.id)!.state === 'completed');
    const afterEnd = recordingUpdates;
    await settle(clock, 2000);
    expect(recordingUpdates).toBe(afterEnd);
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
    expect(services.alerts.list().some((a) => a.message.includes('CONCURRENT_LIMIT_REACHED'))).toBe(true);
    expect(services.manager.isRoomActive(r1.id)).toBe(true);
    expect(services.manager.isRoomActive(r2.id)).toBe(true);
    services.scheduler.stop();
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

  it('fails a recording that never confirms start after the 30s pending timeout', async () => {
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
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/15', displayName: 'P' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    await waitFor(() => services.rooms.get(room.id)!.monitorState === 'recording');
    expect(services.recordings.list({ roomId: room.id }).items[0]!.state).toBe('pending');

    await settle(clock, 30_000);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items[0]!.state === 'failed');
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    expect(rec.failureReason?.code).toBe('RECORDING_START_FAILED');
    expect(services.rooms.get(room.id)!.monitorState).toBe('failed');
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
  });

  it('reconnects with 5/15/45s backoff, splitting segments, then fails on exhaustion', async () => {
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
      failError: { code: 'STREAM_DISCONNECTED', message: '断流', roomId: null, recordingId: null, occurredAt: 'x', retryable: true },
    };
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/16', displayName: 'R' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const rec1 = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec1.id)!.state === 'reconnecting');

    await settle(clock, 5_000);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 2);
    const rec2 = services.recordings.list({ roomId: room.id }).items.find((r) => r.id !== rec1.id)!;
    await waitFor(() => services.recordings.get(rec2.id)!.state === 'reconnecting');

    await settle(clock, 15_000);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 3);
    const rec3 = services.recordings.list({ roomId: room.id }).items.find((r) => r.id !== rec1.id && r.id !== rec2.id)!;
    await waitFor(() => services.recordings.get(rec3.id)!.state === 'reconnecting');

    await settle(clock, 45_000);
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length === 4);
    const rec4 = services.recordings.list({ roomId: room.id }).items.find((r) => r.id !== rec1.id && r.id !== rec2.id && r.id !== rec3.id)!;
    await waitFor(() => services.recordings.get(rec4.id)!.state === 'failed');

    const recs = services.recordings.list({ roomId: room.id }).items;
    expect(recs).toHaveLength(4);
    const byId = new Map(recs.map((r) => [r.id, r]));
    expect(byId.get(rec4.id)!.state).toBe('failed');
    expect(byId.get(rec4.id)!.failureReason?.code).toBe('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED');
    expect(byId.get(rec1.id)!.state).toBe('completed');
    expect(byId.get(rec2.id)!.state).toBe('completed');
    expect(byId.get(rec3.id)!.state).toBe('completed');
    expect(byId.get(rec2.id)!.retryCount).toBe(1);
    expect(byId.get(rec3.id)!.retryCount).toBe(2);
    expect(services.rooms.get(room.id)!.monitorState).toBe('failed');
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
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
    expect(services.alerts.list().some((a) => a.message.includes('DISK_SPACE_INSUFFICIENT'))).toBe(true);
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

  it('immediately continues recording on natural end while still live (#43)', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b6n-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    // 自然结束后的 checkLiveStatus 返回 live → 立即开新段续录，无需等调度器。
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 's1' },
      { status: 'live', streamSessionId: 's1' },
    ]);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/20', displayName: 'N' });

    await services.manager.maybeStartRecording(room, { streamSessionId: 's1' });
    const first = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(first.id)!.state === 'recording');

    // 引擎自然结束后，handleNaturalEnd 检测仍 live → 立即开第二段。
    for (let i = 0; i < 20 && services.recordings.list({ roomId: room.id }).items.length < 2; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.list({ roomId: room.id }).items.length >= 2);
    const recs = services.recordings.list({ roomId: room.id }).items;
    expect(recs.length).toBeGreaterThanOrEqual(2);
    // list 按 started_at 倒序：recs[0]=新段（recording），recs[1]=旧段（completed）
    expect(recs[0]!.state).toBe('recording');
    expect(recs.some((r) => r.state === 'completed')).toBe(true);
    // 会话保持激活：同一场连续录制，room 仍 recording，不经过 completed/idle。
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe('recording');
    expect(services.recordings.activeCount()).toBe(1);

    const activeRec = services.recordings.list({ roomId: room.id }).items.find((r) => r.state === 'recording')!;
    await services.manager.stopRecording(room.id);
    for (let i = 0; i < 20 && services.recordings.get(activeRec.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(activeRec.id)!.state === 'completed');
  });
});