import { statSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { PreviewSink } from "../../src/core/recorder-manager.js";
import { buildServices, type Services } from "../../src/core/services.js";
import { FakeMailer } from "../../src/mail/mailer.js";
import {
  buildMinimalFlv,
  FakePlatformAdapter,
} from "../../src/platform/fake-adapter.js";
import {
  FakeRecordingEngine,
  type FakeEngineScript,
} from "../../src/recorder/fake-engine.js";
import type { RecordingEngine } from "../../src/recorder/engine.js";
import { FakeDiskGuard } from "../../src/storage/disk-guard.js";
import { AppError } from "../../src/types/error.js";
import type { AppSettings } from "../../src/types/index.js";

function baseSettings(dir: string): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: "original",
    autoRecord: true,
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: {
      enabled: true,
      host: "smtp.x.com",
      port: 465,
      secure: true,
      username: "u",
      from: "f",
      recipients: ["a@b.c"],
    },
    dedupeWindowMinutes: 30,
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
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
async function waitForWithClock(
  clock: FakeClock,
  fn: () => boolean,
  attempts = 60,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fn()) return;
    await settle(clock, 500);
  }
  throw new Error("waitForWithClock timeout");
}

class FakePreview implements PreviewSink {
  frames = new Map<string, number>();
  closed: { roomId: string; code: number; reason?: "ended" | "stream_lost" }[] =
    [];
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
  closeRoom(
    roomId: string,
    code: number,
    reason?: "ended" | "stream_lost",
  ): void {
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

describe("RecorderManager", () => {
  it("uses the filename-rule result as the history title for floating recordings", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-floating-title-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save({
      ...baseSettings(dir),
      namingRule: "{platform}_{roomId}_{quality}",
    });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/101",
      displayName: "不应作为历史标题的房间名",
    });

    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "floating-title", streamTitle: room.displayName },
      { manual: true, origin: "floating" },
    );
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.filePath !== null);
    const saved = services.recordings.get(rec.id)!;

    expect(saved.streamTitle).toBe(path.parse(saved.filePath!).name);
    expect(saved.streamTitle).not.toBe(room.displayName);
    await services.manager.stopRecording(room.id);
  });

  it("keeps the filename-rule title when floating recording reuses a preview stream", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(
      path.join(tmpdir(), "lr-floating-preview-title-"),
    );
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save({
      ...baseSettings(dir),
      namingRule: "{roomId}_{platform}",
    });
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/102",
      displayName: "预览房间名",
    });
    services.rooms.setLiveStatus(room.id, "live");
    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewReadyForRecording(room.id));

    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "floating-preview", streamTitle: room.displayName },
      { manual: true, origin: "floating" },
    );
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.filePath !== null);
    const saved = services.recordings.get(rec.id)!;

    expect(saved.streamTitle).toBe(path.parse(saved.filePath!).name);
    expect(saved.streamTitle).not.toBe(room.displayName);
    await services.manager.stopRecording(room.id);
  });

  it("records a live stream to completion, forwards preview frames and closes with 1000", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    // 自然结束后要"连续两次探测到未开播"才收尾，所以这里给两次 offline。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "offline" },
      { status: "offline" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/10",
      displayName: "主播X",
    });

    await services.manager.maybeStartRecording(room, {
      streamSessionId: "s1",
      streamTitle: "T1",
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");
    expect(rec.filePath).toBeNull();
    const withPath = services.recordings.get(rec.id)!;
    expect(
      withPath.filePath?.startsWith(path.join(dir, "bilibili") + path.sep),
    ).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe("recording");

    for (
      let i = 0;
      i < 40 && services.recordings.get(rec.id)!.state !== "completed";
      i += 1
    ) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(rec.id)!.state === "completed");
    const done = services.recordings.get(rec.id)!;
    expect(done.state).toBe("completed");
    expect(done.fileSizeBytes).toBeGreaterThan(13);
    // 自然结束后 handleNaturalEnd 需等待短暂退避再确认下播，最终收口为 completed。
    for (
      let i = 0;
      i < 20 && services.rooms.get(room.id)!.monitorState !== "completed";
      i += 1
    ) {
      await settle(clock, 500);
    }
    expect(services.rooms.get(room.id)!.monitorState).toBe("completed");
    expect(preview.frames.get(room.id)! >= 1).toBe(true);
    expect(preview.closed).toContainEqual({
      roomId: room.id,
      code: 1000,
      reason: "ended",
    });
  });

  it("does not emit recording:updated every second during recording (perf: 前端本地时长 ticker 替代，FE 采纳 #165 性能建议③)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-tick-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "offline" },
      { status: "offline" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/9",
      displayName: "Ticker",
    });

    let recordingUpdates = 0;
    services.events.on((e) => {
      if (e.type === "recording:updated" && e.data.state === "recording")
        recordingUpdates += 1;
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "t1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");
    const atStart = recordingUpdates;
    expect(atStart).toBeGreaterThanOrEqual(1); // file_created 补发

    // 录制期间推进 3 秒：不应再有每秒周期补发（后端 ticker 已移除，时长由前端本地 ticker 走时）。
    await settle(clock, 1000);
    await settle(clock, 1000);
    await settle(clock, 1000);
    expect(recordingUpdates).toBe(atStart);

    // 结束后仍无多余事件。
    for (
      let i = 0;
      i < 20 && services.recordings.get(rec.id)!.state !== "completed";
      i += 1
    )
      await settle(clock, 500);
    await waitFor(() => services.recordings.get(rec.id)!.state === "completed");
    expect(recordingUpdates).toBe(atStart);
  });

  it("resets the preview header buffer at each new recording session so a fresh FLV header is captured (#150 跨录制不残留旧头)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-reset-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "offline" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/8",
      displayName: "Reset",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "r1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");
    // 每个新录制会话开始（runSession）都会清空预览头缓冲，确保下一段流的 FLV 头被重新捕获。
    expect(preview.resets).toContain(room.id);
  });

  it("keeps the preview stream open while recording starts and stops", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-preview-handoff-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/81",
      displayName: "Handoff",
    });
    services.rooms.setLiveStatus(room.id, "live");

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewReadyForRecording(room.id));
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "handoff-1" },
      { manual: true },
    );

    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(preview.closed).toEqual([]);
    expect(preview.resets).not.toContain(room.id);

    await services.manager.stopRecording(room.id);
    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(preview.closed).toEqual([]);
  });

  it("reuses a ready preview without another platform stream lookup", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(
      path.join(tmpdir(), "lr-preview-reuse-no-lookup-"),
    );
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/810",
      displayName: "Reuse",
    });
    services.rooms.setLiveStatus(room.id, "live");

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));
    const adapter = services.adapterFor("bilibili") as FakePlatformAdapter;
    const lookup = vi.spyOn(adapter, "getStreamUrl");

    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "reuse-1" },
      { manual: true },
    );

    expect(lookup).not.toHaveBeenCalled();
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    lookup.mockRestore();
    await services.manager.stopRecording(room.id);
  });

  it("creates the final shared-recording file before creating its database record", async () => {
    const clock = new FakeClock();
    const base = await mkdtemp(path.join(tmpdir(), "lr-preview-baddir-"));
    const blocker = path.join(base, "not-a-directory");
    await writeFile(blocker, "x");
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(path.join(blocker, "recordings")));
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/812",
      displayName: "Shared bad directory",
    });
    services.rooms.setLiveStatus(room.id, "live");

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));

    await expect(
      services.manager.maybeStartRecording(
        room,
        { streamSessionId: "shared-baddir" },
        { manual: true },
      ),
    ).rejects.toMatchObject({ code: "RECORDING_DIRECTORY_INVALID" });
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    await services.manager.stopPreviewStream(room.id);
  });

  it("coalesces concurrent preview opens into one platform stream lookup", async () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ":memory:", clock });
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/811",
      displayName: "Single flight",
    });
    services.rooms.setLiveStatus(room.id, "live");
    const adapter = services.adapterFor("bilibili") as FakePlatformAdapter;
    const original = adapter.getStreamUrl.bind(adapter);
    const lookup = vi
      .spyOn(adapter, "getStreamUrl")
      .mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return original(...args);
      });

    await Promise.all([
      services.manager.ensurePreviewStream(room.id),
      services.manager.ensurePreviewStream(room.id),
      services.manager.ensurePreviewStream(room.id),
    ]);

    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
    await services.manager.stopPreviewStream(room.id);
  });

  it("keeps a shared recording running when its last preview client closes", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(
      path.join(tmpdir(), "lr-preview-close-recording-"),
    );
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/82",
      displayName: "Close while recording",
    });
    services.rooms.setLiveStatus(room.id, "live");

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "close-while-recording" },
      { manual: true },
    );
    expect(services.manager.isRoomActive(room.id)).toBe(true);

    // 与最后一个预览 WebSocket 断开时 server.ts 调用的路径一致。
    await services.manager.stopPreviewStream(room.id);

    expect(services.manager.isPreviewStreaming(room.id)).toBe(true);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
  });

  it("marks a 0-byte recording as failed and removes the empty file, not completed (#165 空文件)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-empty-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    // 自定义引擎：file_created 后立即 completed(fileSize 0)——模拟取流无数据。
    const emptyEngine: RecordingEngine = {
      stop: async () => undefined,
      async *start(input, outputPath) {
        yield { type: "file_created", filePath: outputPath ?? "" };
        yield { type: "completed", fileSize: 0 };
      },
    };
    services.engineFor = () => emptyEngine as never;
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "offline" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/77",
      displayName: "Empty",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "e1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    for (
      let i = 0;
      i < 40 && services.recordings.get(rec.id)!.state !== "failed";
      i += 1
    )
      await settle(clock, 1000);
    const after = services.recordings.get(rec.id)!;
    expect(after.state).toBe("failed");
    expect(after.failureReason?.code).toBe("RECORDING_EMPTY");
    expect(services.rooms.get(room.id)!.monitorState).toBe("failed");
  });

  it("enforces maxConcurrentRecordings and raises CONCURRENT_LIMIT_REACHED", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6c-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "live", streamSessionId: "s1" },
      { status: "live", streamSessionId: "s2" },
      { status: "live", streamSessionId: "s3" },
    ]);
    const r1 = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/11",
      displayName: "A",
    });
    const r2 = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/12",
      displayName: "B",
    });
    const r3 = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/13",
      displayName: "C",
    });

    services.scheduler.start();
    await settle(clock, 60_000);
    await waitFor(() => services.recordings.activeCount() === 2);

    expect(services.manager.activeRoomIds()).toHaveLength(2);
    expect(services.recordings.activeCount()).toBe(2);
    const r3State = services.rooms.get(r3.id)!;
    expect(r3State.monitorState).toBe("idle");
    expect(r3State.lastError?.code).toBe("CONCURRENT_LIMIT_REACHED");
    expect(
      services.alerts
        .list()
        .some((a) => a.errorCode === "CONCURRENT_LIMIT_REACHED"),
    ).toBe(true);
    expect(services.manager.isRoomActive(r1.id)).toBe(true);
    expect(services.manager.isRoomActive(r2.id)).toBe(true);
    services.scheduler.stop();
  });

  it("starts at most maxConcurrentRecordings when rooms go live concurrently", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6c-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const rooms = ["21", "22", "23"].map((num, index) =>
      services.rooms.create({
        platform: "bilibili",
        url: `https://live.bilibili.com/${num}`,
        displayName: `C${index + 1}`,
      }),
    );

    // 调度器按 PLATFORM_CHECK_CONCURRENCY 并发检测房间，三个房间会在同一轮一起开播。
    // 额度判定必须发生在第一个 await 之前，否则三个房间会全部通过检查、并发数超过上限。
    const started = await Promise.all(
      rooms.map((room, index) =>
        services.manager.maybeStartRecording(room, {
          streamSessionId: `c${index + 1}`,
        }),
      ),
    );

    expect(started.filter(Boolean)).toHaveLength(2);
    expect(services.recordings.activeCount()).toBe(2);
    const denied = rooms
      .map((room) => services.rooms.get(room.id)!)
      .filter((room) => room.lastError?.code === "CONCURRENT_LIMIT_REACHED");
    expect(denied).toHaveLength(1);
    expect(
      services.alerts
        .list()
        .filter((alert) => alert.errorCode === "CONCURRENT_LIMIT_REACHED"),
    ).toHaveLength(1);

    await Promise.all(
      rooms.map((room) => services.manager.stopRecording(room.id)),
    );
  });

  it("dedupes an already-active recording without relying on streamSessionId", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6d-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/14",
      displayName: "D",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    await waitFor(
      () => services.recordings.list({ roomId: room.id }).items.length === 1,
    );
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
  });

  it('treats "no data after 30s" as a retryable interruption instead of failing outright', async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6p-"));
    const services = buildServices({ dbPath: ":memory:", clock });
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
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/15",
      displayName: "P",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    await waitFor(
      () => services.rooms.get(room.id)!.monitorState === "recording",
    );
    expect(services.recordings.list({ roomId: room.id }).items[0]!.state).toBe(
      "pending",
    );

    // 30 秒拿不到数据 → 进入重试，而不是一次判死。
    await waitForWithClock(
      clock,
      () =>
        services.recordings.list({ roomId: room.id }).items[0]!.state ===
        "reconnecting",
      80,
    );

    // 重试额度耗尽后才收尾；全程只有一条记录，不因为重试多出记录。
    await waitForWithClock(
      clock,
      () =>
        services.recordings.list({ roomId: room.id }).items[0]!.state ===
        "failed",
      500,
    );
    const recs = services.recordings.list({ roomId: room.id }).items;
    expect(recs).toHaveLength(1);
    expect(recs[0]!.failureReason?.code).toBe(
      "STREAM_DISCONNECTED_RECONNECT_EXHAUSTED",
    );
    // 失败原因要带上真正的原因，而不是笼统的"次数已耗尽"。
    expect(recs[0]!.failureReason?.message).toContain("等待直播数据超时");
    expect(services.rooms.get(room.id)!.monitorState).toBe("failed");
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
  });

  it("reconnects into the same file: one recording, appended bytes, interruption noted on the row", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6r-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: {
        code: "NETWORK_UNAVAILABLE",
        message: "拉流失败 HTTP 503",
        roomId: null,
        recordingId: null,
        occurredAt: "x",
        retryable: true,
      },
    };
    // 一直开播：让 5/15/45 三次退避重连都真的发生，最后才耗尽。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/16",
      displayName: "R",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.filePath !== null,
    );
    const filePath = services.recordings.get(rec.id)!.filePath!;

    // 重连耗尽但文件里有数据 → 收成"已完成 + 中途中断"，而不是把整条录制判失败。
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
      300,
    );
    const after = services.recordings.get(rec.id)!;
    // 关键回归：重连不再新开文件、不再新建记录。
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    expect(after.filePath).toBe(filePath);
    expect(after.endReason).toBe("interrupted");
    expect(after.fileSizeBytes).toBeGreaterThan(13);
    // 失败原因要带上真正的原因，而不是笼统的"次数已耗尽"。
    expect(after.failureReason?.code).toBe(
      "STREAM_DISCONNECTED_RECONNECT_EXHAUSTED",
    );
    expect(after.failureReason?.message).toContain("网络中断");
    // 中断期间的缺失时长要累计到这条录制上。
    expect(after.missingMs).toBeGreaterThan(0);
    expect(services.rooms.get(room.id)!.monitorState).toBe("completed");
    expect(preview.closed.some((c) => c.code === 4004)).toBe(true);
    // 续录是追加写入：整个文件里只应有一个 FLV 头。
    expect(
      (await readFile(filePath)).toString("latin1").split("FLV").length - 1,
    ).toBe(1);
  });

  it("keeps retrying when the reconnect probe cannot confirm liveness, and records a real reason", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-probe-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: {
        code: "NETWORK_UNAVAILABLE",
        message: "拉流失败 HTTP 503",
        roomId: null,
        recordingId: null,
        occurredAt: "x",
        retryable: true,
      },
    };
    // 断流后的存活探测永远拿不到确定结论（受限/网络错误）：以前会被当成"已下播"静默收成 natural 且无原因，
    // 现在必须继续重试，并在额度耗尽后按中断收尾、留下真正的原因。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript(
      Array.from({ length: 40 }, () => ({ status: "restricted" as const })),
    );
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/92",
      displayName: "Probe",
    });

    await services.manager.maybeStartRecording(room, {
      streamSessionId: "probe",
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
      800,
    );
    const after = services.recordings.get(rec.id)!;
    expect(after.endReason).toBe("interrupted");
    expect(after.failureReason?.code).toBe(
      "STREAM_DISCONNECTED_RECONNECT_EXHAUSTED",
    );
  });

  it("records a reason instead of a silent natural end when re-pulling after a natural end fails", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-natural-refail-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 3,
      intervalMs: 500,
    };
    // 第一次取流成功（起录），之后取流一律失败：自然结束后的续录取流失败不能当成"直播正常结束"。
    const inner = services.adapterFor("bilibili");
    let urlCalls = 0;
    services.adapterFor = () => ({
      platform: "bilibili" as const,
      checkLiveStatus: async () => ({ status: "live" as const }),
      getStreamUrl: async (url, quality) => {
        urlCalls += 1;
        if (urlCalls > 1)
          throw new AppError("NETWORK_UNAVAILABLE", "拉流失败", {
            retryable: true,
          });
        return inner.getStreamUrl(url, quality);
      },
      normalizeUrl: (url: string) => inner.normalizeUrl(url),
      validateUrl: () => true,
    });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/93",
      displayName: "NaturalRefail",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "nr" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
      800,
    );
    const after = services.recordings.get(rec.id)!;
    expect(after.endReason).toBe("interrupted");
    expect(after.failureReason).not.toBeNull();
  });

  it("hands a shared (preview) recording back to the normal path when the preview stream ends", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-preview-shared-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    // 预览引擎播完即收束（触发接力）；接力后的普通拉流持续产出，不在这条用例里结束。
    let engineCalls = 0;
    services.engineFor = () => {
      engineCalls += 1;
      return new FakeRecordingEngine(
        clock,
        engineCalls === 1
          ? { frames: 6, intervalMs: 500 }
          : { frames: 1000, intervalMs: 500 },
      );
    };
    // 上游收束后接力时主播仍在播：应恢复续录，而不是收尾。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "live", streamSessionId: "shared-end", streamTitle: "T" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/83",
      displayName: "SharedEnd",
    });
    services.rooms.setLiveStatus(room.id, "live");

    await services.manager.ensurePreviewStream(room.id);
    await waitFor(() => services.manager.isPreviewStreaming(room.id));
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "shared-end" },
      { manual: true },
    );
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    expect(services.manager.isRoomActive(room.id)).toBe(true);

    // 预览引擎播完 → 上游自然收束 → 录制应接力到普通路径，而不是被静默收尾。
    await waitForWithClock(
      clock,
      () => !services.manager.isPreviewStreaming(room.id),
      40,
    );
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.recordings.get(rec.id)!.state).toBe("recording");

    // 推进时钟让接力跑完退避并真正恢复拉流，再手动停止，避免测试尾部留下半接力状态。
    for (let i = 0; i < 20; i += 1) await settle(clock, 500);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.recordings.get(rec.id)!.state).toBe("recording");
    expect(services.recordings.get(rec.id)!.endReason).toBeUndefined();
    // 预览房间不能被收掉：观看端还连着，收掉会连 FLV 初始化段一起删掉，重连后永远起不来。
    expect(preview.closed).toEqual([]);

    await services.manager.stopRecording(room.id);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });

  it("requires two consecutive offline probes: a single one must not end the recording", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-offline-once-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    // 第一段自然结束后触发下播确认；接力后的拉流持续产出，确保这条录制还能继续。
    let engineCalls = 0;
    services.engineFor = () => {
      engineCalls += 1;
      return new FakeRecordingEngine(
        clock,
        engineCalls === 1
          ? { frames: 6, intervalMs: 500 }
          : { frames: 1000, intervalMs: 500 },
      );
    };
    // 第一次探测给 offline（平台的瞬时空响应），复核给 live：不得收尾，必须继续录。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "offline" },
      { status: "live", streamSessionId: "s1" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/96",
      displayName: "OnceOffline",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");

    // 推进足够时间跑完自然结束的退避 + 确认探测 + 重连：录制应当还活着。
    for (let i = 0; i < 60; i += 1) await settle(clock, 500);
    expect(services.recordings.get(rec.id)!.state).toBe("recording");
    expect(services.recordings.get(rec.id)!.endReason).toBeUndefined();
    expect(services.manager.isRoomActive(room.id)).toBe(true);

    await services.manager.stopRecording(room.id);
  });

  it("records the silent tail when stopping a stalled recording (断网后停止也能看出丢了多久)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-stall-stop-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    // 第一帧之后长时间不再出数据、引擎也不报错：断网但连接没断的典型形态。
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 100,
      intervalMs: 60_000,
    };
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/94",
      displayName: "Stalled",
    });

    await services.manager.maybeStartRecording(room, {
      streamSessionId: "stall",
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");

    // 静默 10 秒后手动停止：这段必须记进缺失时长，历史里才会出现"中途缺失 N 秒"。
    await settle(clock, 10_000);
    await services.manager.stopRecording(room.id);

    const after = services.recordings.get(rec.id)!;
    expect(after.endReason).toBe("stopped");
    expect(after.missingMs).toBeGreaterThanOrEqual(5_000);
  });

  it("does not invent a gap on a normal manual stop right after data", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-quick-stop-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 100,
      intervalMs: 60_000,
    };
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/95",
      displayName: "QuickStop",
    });

    await services.manager.maybeStartRecording(room, {
      streamSessionId: "quick",
    });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");
    await services.manager.stopRecording(room.id);

    // 正常停止不该冒出"中途缺失"：阈值以内一律算 0。
    expect(services.recordings.get(rec.id)!.missingMs).toBe(0);
  });

  it("starts the recording even when disk space is low, but still warns (磁盘不足不再阻止录制)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6l-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    (services.diskGuard as FakeDiskGuard).setSpace({
      freeBytes: 1024,
      totalBytes: 100 * 1024 ** 3,
    });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/17",
      displayName: "L",
    });

    // 空间不足只提醒、不拦下录制：能不能录交给实际写入决定（写不进去时会有明确失败原因）。
    const started = await services.manager.maybeStartRecording(room, {
      streamSessionId: "s1",
    });
    expect(started).toBe(true);
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    // 但告警/通知照旧，用户仍然知道磁盘紧张。
    const mailer = services.mailer as FakeMailer;
    expect(mailer.sent.some((m) => m.subject.includes("磁盘空间不足"))).toBe(
      true,
    );
    expect(
      services.alerts
        .list()
        .some((a) => a.errorCode === "DISK_SPACE_INSUFFICIENT"),
    ).toBe(true);

    await services.manager.stopRecording(room.id);
  });

  it("stopRecording completes the current segment with code 1000", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6s-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/18",
      displayName: "S",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(() => services.recordings.get(rec.id)!.state === "recording");

    await services.manager.stopRecording(room.id);
    for (
      let i = 0;
      i < 10 && services.recordings.get(rec.id)!.state !== "completed";
      i += 1
    ) {
      await settle(clock, 500);
    }
    await waitFor(() => services.recordings.get(rec.id)!.state === "completed");
    expect(services.rooms.get(room.id)!.monitorState).toBe("completed");
    expect(preview.closed).toContainEqual({
      roomId: room.id,
      code: 1000,
      reason: "ended",
    });
  });

  it("manual re-check re-records the same broadcast after a manual stop (skips dedup)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6m-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/19",
      displayName: "M",
    });
    const liveStartedAt = clock.iso();

    // 第一次录制同一场（session s1），随后手动停止 → completed
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "s1" },
      { liveStartedAt },
    );
    const first = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitFor(
      () => services.recordings.get(first.id)!.state === "recording",
    );
    await services.manager.stopRecording(room.id);
    for (
      let i = 0;
      i < 10 && services.recordings.get(first.id)!.state !== "completed";
      i += 1
    ) {
      await settle(clock, 500);
    }
    await waitFor(
      () => services.recordings.get(first.id)!.state === "completed",
    );
    expect(services.manager.isRoomActive(room.id)).toBe(false);

    // 自动轮询（非手动）应被同场去重，不再重复录制
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "s1" },
      { liveStartedAt },
    );
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);

    // 手动再次检测应跳过去重、重新录制同一场
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "s1" },
      { manual: true },
    );
    await waitFor(
      () => services.recordings.list({ roomId: room.id }).items.length === 2,
    );
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(2);
    expect(services.rooms.get(room.id)!.monitorState).toBe("recording");
  });

  it("continues into the same file on natural end while still live (#43)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-b6n-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    const preview = new FakePreview();
    services.manager.preview = preview;
    // 自然结束后一直开播 → 立即接着录，无需等调度器（脚本耗尽后回落 live）。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/20",
      displayName: "N",
    });

    const states: string[] = [];
    services.events.on((e) => {
      if (e.type === "recording:updated" && e.data.roomId === room.id)
        states.push(e.data.state);
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.filePath !== null,
    );
    const filePath = services.recordings.get(rec.id)!.filePath!;
    const flvLen = buildMinimalFlv().length;
    const segmentBytes = flvLen + 5 * (flvLen - 9);

    // 自然结束后继续录同一场：同一个文件继续变大，记录数始终是 1（不再每段一条记录 + 一个文件）。
    for (
      let i = 0;
      i < 60 && (await stat(filePath)).size <= segmentBytes;
      i += 1
    )
      await settle(clock, 500);
    expect((await stat(filePath)).size).toBeGreaterThan(segmentBytes);
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.monitorState).toBe("recording");
    // 续录不再清空预览头缓冲：续录段跳过 FLV 头，清了之后中途加入的预览就永远等不到初始化段。
    expect(preview.resets.filter((id) => id === room.id)).toHaveLength(1);

    // 中途不能出现"已完成"后又回到录制中——那会让用户在录制过程中收到一次"录制完成"提示。
    const firstCompleted = states.indexOf("completed");
    if (firstCompleted !== -1) {
      expect(
        states
          .slice(firstCompleted + 1)
          .some((s) => s === "recording" || s === "reconnecting"),
      ).toBe(false);
    }

    await services.manager.stopRecording(room.id);
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
    );
    expect(services.recordings.get(rec.id)!.endReason).toBe("stopped");
    // 追加写入：整个文件里只有一个 FLV 头。
    expect(
      (await readFile(filePath)).toString("latin1").split("FLV").length - 1,
    ).toBe(1);
  });

  it("rejects start when the save directory is unusable and never counts it as active (直播墙/预览点录制计数虚增回归)", async () => {
    const clock = new FakeClock();
    const base = await mkdtemp(path.join(tmpdir(), "lr-baddir-"));
    // 用一个文件占用目录位置：mkdir 必然失败，且与权限无关（跨平台确定）。
    const blocker = path.join(base, "not-a-directory");
    await writeFile(blocker, "x");

    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(path.join(blocker, "recordings")));
    (services.diskGuard as FakeDiskGuard).setSpace({
      freeBytes: 1e12,
      totalBytes: 2e12,
    });
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([
      { status: "live", streamSessionId: "s-baddir", streamTitle: "T" },
    ]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/9100",
      displayName: "BadDir",
    });

    for (let i = 0; i < 3; i += 1) {
      // 每次点击都必须明确报错，并且不能留下 pending 记录——
      // 否则「录制中」计数逐个累加，最终占满并发名额导致再也无法录制。
      await expect(
        services.manager.maybeStartRecording(room, {
          streamSessionId: "s-baddir",
        }),
      ).rejects.toMatchObject({
        code: "RECORDING_DIRECTORY_INVALID",
        message: "保存目录无效，录制失败",
      });
      expect(services.recordings.activeCount()).toBe(0);
    }
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(0);
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });

  it("enqueues post-processing once for the merged recording (mp4_after/上传 收尾)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-mp4-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save({
      ...baseSettings(dir),
      recordingFormat: "mp4_after",
      openlist: {
        enabled: true,
        serverUrl: "https://dav.example.com/dav",
        directoryTemplate: "{room}",
        username: "u",
      },
    } as AppSettings);
    await services.secretStore.set("openlist.token", "tok");
    services.manager.preview = new FakePreview();
    // 一直开播 → 自然结束后同文件续录（不新增记录）。
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/21",
      displayName: "P",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.filePath !== null,
    );
    const filePath = services.recordings.get(rec.id)!.filePath!;
    const flvLen = buildMinimalFlv().length;
    const segmentBytes = flvLen + 5 * (flvLen - 9);
    // 等续录真的发生（同一个文件被追加了第二段数据）。
    for (
      let i = 0;
      i < 60 && (await stat(filePath)).size <= segmentBytes;
      i += 1
    )
      await settle(clock, 500);

    await services.manager.stopRecording(room.id);
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
    );
    // 合并成一个文件后，后处理/上传只针对这一条录制入队一次。
    await waitForWithClock(
      clock,
      () => services.uploader.uploadRepo.jobForRecording(rec.id) !== null,
    );
    expect(services.uploader.uploadRepo.jobForRecording(rec.id)).not.toBeNull();
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(1);
  });

  it("times out and retries when the stream opens but never sends data (HTTP 200 后卡住不吐字节)", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-stall-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    // 只发 file_created、之后永不出数据：平台返回 200 后卡住的典型形态。
    const stalledEngine: RecordingEngine = {
      stop: async () => undefined,
      async *start(_input, outputPath) {
        yield { type: "file_created", filePath: outputPath ?? "" };
        await new Promise(() => {});
      },
    };
    services.engineFor = () => stalledEngine as never;
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/40",
      displayName: "Stall",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "recording",
    );

    // 回归：file_created 不能撤销启动超时。否则这种情况会一直挂在"录制中"，占着并发名额且永不告警。
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "reconnecting",
      100,
    );
  });

  it("finishes the recording when the user stops during the retry backoff instead of wedging the room", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-stop-backoff-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (engineOf(services) as unknown as { script: FakeEngineScript }).script = {
      frames: 2,
      intervalMs: 500,
      failAfterMs: 30,
      failError: {
        code: "NETWORK_UNAVAILABLE",
        message: "拉流失败",
        roomId: null,
        recordingId: null,
        occurredAt: "x",
        retryable: true,
      },
    };
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/41",
      displayName: "StopBackoff",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "reconnecting",
    );

    // 退避期间点停止：必须收尾并释放会话，否则记录永远停在"重连中"、并发名额不释放、停止请求一直挂着。
    const stopping = services.manager.stopRecording(room.id);
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.state === "completed",
    );
    await stopping;
    expect(services.recordings.get(rec.id)!.endReason).toBe("stopped");
    expect(services.manager.isRoomActive(room.id)).toBe(false);
    expect(services.recordings.activeCount()).toBe(0);
  });

  it("stops the pull and flushes the file on shutdown, leaving the record to startup recovery", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-shutdown-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/50",
      displayName: "Shutdown",
    });

    await services.manager.maybeStartRecording(room, { streamSessionId: "s1" });
    const rec = services.recordings.list({ roomId: room.id }).items[0]!;
    await waitForWithClock(
      clock,
      () => services.recordings.get(rec.id)!.filePath !== null,
    );
    const filePath = services.recordings.get(rec.id)!.filePath!;
    for (
      let i = 0;
      i < 40 &&
      (statSync(filePath, { throwIfNoEntry: false })?.size ?? 0) <= 13;
      i += 1
    ) {
      await settle(clock, 500);
    }

    // 退出：必须立刻返回（不能被拉流卡住），并且拉流真的停了。
    await services.manager.shutdown();
    const sizeAtExit = statSync(filePath).size;
    await settle(clock, 5_000);
    expect(statSync(filePath).size).toBe(sizeAtExit);
    expect(sizeAtExit).toBeGreaterThan(13);
    // 记录状态不在这里改：交给下次启动的恢复流程统一收口（服务重启中断 + 补跑收尾）。
    expect(services.recordings.get(rec.id)!.state).toBe("recording");
  });

  it("re-records the same broadcast after a network interruption, but not after a service restart", async () => {
    const clock = new FakeClock();
    const dir = await mkdtemp(path.join(tmpdir(), "lr-dedupe-"));
    const services = buildServices({ dbPath: ":memory:", clock });
    services.settings.save(baseSettings(dir));
    services.manager.preview = new FakePreview();
    (services.adapterFor("bilibili") as FakePlatformAdapter).setScript([]);
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/30",
      displayName: "Dedupe",
    });
    const liveStartedAt = clock.iso();

    // 网络中断收尾：有数据、标 interrupted。
    const interrupted = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: "bilibili",
      streamSessionId: "same-session",
      streamTitle: "T",
    });
    services.recordings.update(interrupted.id, {
      state: "completed",
      endReason: "interrupted",
    });

    // 主播还在播：同一场必须还能再录，否则网络恢复后剩下的直播永远不会被录。
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "same-session" },
      { liveStartedAt },
    );
    await waitForWithClock(
      clock,
      () => services.recordings.list({ roomId: room.id }).items.length === 2,
    );
    await services.manager.stopRecording(room.id);
    await waitForWithClock(
      clock,
      () => !services.manager.isRoomActive(room.id),
    );

    // 服务重启中断：不算"没录过"，同一场被去重挡住（不自动续录）。
    const restarted = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: "bilibili",
      streamSessionId: "restart-session",
      streamTitle: "T",
    });
    services.recordings.update(restarted.id, {
      state: "completed",
      endReason: "service_restart",
    });
    const beforeRestart = services.recordings.list({ roomId: room.id }).items
      .length;
    await services.manager.maybeStartRecording(
      room,
      { streamSessionId: "restart-session" },
      { liveStartedAt },
    );
    expect(services.recordings.list({ roomId: room.id }).items).toHaveLength(
      beforeRestart,
    );
    expect(services.manager.isRoomActive(room.id)).toBe(false);
  });

});
