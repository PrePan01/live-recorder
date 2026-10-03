import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import {
  FakeRecordingEngine,
  type FakeEngineScript,
} from '../../src/recorder/fake-engine.js';
import type { AppSettings, ErrorObject } from '../../src/types/index.js';

/**
 * 写盘失败自动恢复录制（PrePan 钦定 2026-09-29）：
 * 失败后立即重启、不间隔、共 3 次；3 次都失败→终停且历史必带明确原因（落库+落日志）；
 * 用户手动介入（点停止/点录制）立即让位，绝不冲突。
 */

const WRITE_ERROR: ErrorObject = {
  code: 'RECORDING_WRITE_FAILED',
  message: '写入录像文件失败（EIO）',
  roomId: null,
  recordingId: null,
  occurredAt: 'x',
  retryable: false,
};

function baseSettings(dir: string): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: 'original',
    autoRecord: true,
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: {
      enabled: true,
      host: 'smtp.x.com',
      port: 465,
      secure: true,
      username: 'u',
      from: 'f',
      recipients: ['a@b.c'],
    },
    dedupeWindowMinutes: 30,
  };
}

async function settle(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

async function waitForWithClock(
  clock: FakeClock,
  fn: () => boolean,
  attempts = 60,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fn()) return;
    await settle(clock, 500);
  }
  throw new Error('waitForWithClock timeout');
}

function engineOf(services: Services): FakeRecordingEngine {
  return services.engineFor() as FakeRecordingEngine;
}

function setScript(services: Services, script: FakeEngineScript): void {
  (engineOf(services) as unknown as { script: FakeEngineScript }).script =
    script;
}

describe('写盘失败自动恢复录制（PrePan 钦定参数）', () => {
  it('写盘失败→立即重启新段续录（第 2 次拉流起恢复，已录内容不丢）', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-write-restart-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    setScript(services, {
      frames: 4,
      intervalMs: 500,
      failAfterMs: 30,
      failError: WRITE_ERROR,
    });
    // 确定性「磁盘恢复」：重启取流（第 2 次 getStreamUrl）时撤掉写盘错误注入。
    const inner = services.adapterFor('bilibili') as FakePlatformAdapter;
    let urlCalls = 0;
    services.adapterFor = () => ({
      platform: 'bilibili' as const,
      checkLiveStatus: async () => ({ status: urlCalls >= 2 ? 'offline' as const : 'live' as const }),
      getStreamUrl: async (url, quality) => {
        urlCalls += 1;
        if (urlCalls >= 2) setScript(services, { frames: 4, intervalMs: 500 });
        return inner.getStreamUrl(url, quality);
      },
      normalizeUrl: (url: string) => inner.normalizeUrl(url),
      validateUrl: () => true,
    });
    const room = services.rooms.create({
      platform: 'bilibili',
      url: 'https://live.bilibili.com/95',
      displayName: '写盘恢复',
    });
    await services.manager.maybeStartRecording(room, {
      streamSessionId: 'wr1',
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === 'completed',
      600,
    );
    const after = services.recordings.get(rec.id)!;
    // 恢复后自然录到流结束：正常收尾（natural），不是失败/中断。
    expect(after.endReason).toBe('natural');
    // 恢复成功后清掉尝试期的失败原因：历史页只在真正失败/中断时显示原因。
    expect(after.failureReason).toBeNull();
    // 新段续录=追加写入同一文件：整个文件只有一个 FLV 头（与网络续录同口径）。
    const text = (await readFile(after.filePath!)).toString('latin1');
    expect(text.split('FLV').length - 1).toBe(1);
  });

  it('3 次都失败→终停且历史必带明确原因（含次数/分类/原文），[record] 落日志', async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    try {
      const dir = await mkdtemp(path.join(tmpdir(), 'lr-write-restart-cap-'));
      const services = buildServices({ dbPath: ':memory:', clock });
      services.settings.save(baseSettings(dir));
      // 每次拉流都写盘失败：重启多少次都白费，3 次后必须终停。
      setScript(services, {
        frames: 4,
        intervalMs: 500,
        failAfterMs: 30,
        failError: WRITE_ERROR,
      });
      (services.adapterFor('bilibili') as FakePlatformAdapter).setScript(
        Array.from({ length: 40 }, () => ({ status: 'live' as const })),
      );
      const room = services.rooms.create({
        platform: 'bilibili',
        url: 'https://live.bilibili.com/96',
        displayName: '写盘三次',
      });
      await services.manager.maybeStartRecording(room, {
        streamSessionId: 'wr2',
      });
      const rec = services.recordings.list({ roomId: room.id }).items[0]!;
      await waitForWithClock(
        clock,
        () => services.recordings.get(rec.id)!.state === 'completed',
        600,
      );
      const after = services.recordings.get(rec.id)!;
      expect(after.endReason).toBe('interrupted');
      // 历史必带明确原因：真实根因 + 恢复次数，而不是笼统一句「录制出现异常」。
      expect(after.failureReason?.code).toBe('RECORDING_WRITE_FAILED');
      expect(after.failureReason?.message).toContain('自动恢复录制');
      expect(after.failureReason?.message).toContain('仍未成功');
      // 主文案是人话；技术原文（EIO）只进 details，不直给用户。
      expect(after.failureReason?.message).toContain('存储设备读写失败');
      expect(after.failureReason?.message).not.toContain('EIO');
      expect(
        (
          after.failureReason?.details as
            | { rootCauseMessage?: string }
            | undefined
        )?.rootCauseMessage,
      ).toContain('EIO');
      expect(
        (after.failureReason?.details as { attempts?: number } | undefined)
          ?.attempts,
      ).toBe(3);
      // 分类枚举随 failureReason 落库（FE 历史页直显「写入失败」）。
      expect(
        (
          after.failureReason?.details as
            | { reasonCategory?: string }
            | undefined
        )?.reasonCategory,
      ).toBe('write_failed');
      // [record] 日志：每次尝试与终停原因都进 backend.log（同 [verify] 款）。
      expect(logs.some((l) => l.includes('[record]') && l.includes(rec.id))).toBe(
        true,
      );
      // 终停后会话释放，不留「重连中」悬挂。
      expect(services.manager.isRoomActive(room.id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('重启尝试期间用户点停止：立即让位，按停止收尾', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-write-restart-stop-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    setScript(services, {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: WRITE_ERROR,
    });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: 'bilibili',
      url: 'https://live.bilibili.com/97',
      displayName: '写盘停手',
    });
    await services.manager.maybeStartRecording(room, {
      streamSessionId: 'wr3',
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    // 确定性「用户在重启尝试进行中点停止」：恢复流程探测在播时触发停止。
    const inner = services.adapterFor('bilibili') as FakePlatformAdapter;
    let hooked = false;
    services.adapterFor = () => ({
      platform: 'bilibili' as const,
      checkLiveStatus: async () => {
        if (!hooked) {
          hooked = true;
          void services.manager.stopRecording(room.id);
        }
        return { status: 'live' as const };
      },
      getStreamUrl: async (url, quality) => inner.getStreamUrl(url, quality),
      normalizeUrl: (url: string) => inner.normalizeUrl(url),
      validateUrl: () => true,
    });
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === 'completed',
      200,
    );
    expect(services.recordings.get(rec.id)!.endReason).toBe('stopped');
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.recordings.activeCount()).toBe(0);
  });

  it('重启尝试期间用户手动点录制：自动重启让位，手动录制接管', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-write-restart-manual-'));
    const services = buildServices({ dbPath: ':memory:', clock });
    services.settings.save(baseSettings(dir));
    setScript(services, {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: WRITE_ERROR,
    });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: 'bilibili',
      url: 'https://live.bilibili.com/98',
      displayName: '写盘手动接管',
    });
    await services.manager.maybeStartRecording(room, {
      streamSessionId: 'wr4',
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    // 确定性「用户在重启尝试进行中手动点录制」：恢复流程探测在播时手动开录，
    // 同时模拟磁盘已恢复（撤掉错误注入）供手动录制使用。
    const inner = services.adapterFor('bilibili') as FakePlatformAdapter;
    let hooked = false;
    let manualStarted: Promise<boolean> | null = null;
    services.adapterFor = () => ({
      platform: 'bilibili' as const,
      checkLiveStatus: async () => {
        if (!hooked) {
          hooked = true;
          setScript(services, { frames: 4, intervalMs: 500 });
          manualStarted = services.manager.maybeStartRecording(
            room,
            { streamSessionId: 'manual-1' },
            { manual: true },
          );
        }
        return { status: 'live' as const };
      },
      getStreamUrl: async (url, quality) => inner.getStreamUrl(url, quality),
      normalizeUrl: (url: string) => inner.normalizeUrl(url),
      validateUrl: () => true,
    });
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === 'completed',
      200,
    );
    // 旧场按停止收尾（内容保留），自动重启让位不再尝试。
    expect(services.recordings.get(rec.id)!.endReason).toBe('stopped');
    // 手动录制接管成功，产生新的录制行。
    await expect(manualStarted!).resolves.toBe(true);
    const items = services.recordings.list({ roomId: room.id }).items;
    expect(items.length).toBe(2);
  });
});
