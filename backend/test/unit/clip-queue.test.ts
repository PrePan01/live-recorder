import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServices } from "../../src/core/services.js";
import { buildApp } from "../../src/api/server.js";
import type { Services } from "../../src/core/services.js";
import { openDatabase } from "../../src/db/connection.js";
import { MIGRATIONS, runMigrations } from "../../src/db/migrations/index.js";
const exportFile = vi.hoisted(() => vi.fn());
vi.mock("../../src/recorder/pipeline-ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportClipFile: (...args: unknown[]) => exportFile(...args),
}));
let services: Services;
let directory: string;
async function setup() {
  directory = await mkdtemp(path.join(tmpdir(), "lr-segments-"));
  services = buildServices({ dbPath: ":memory:" });
  vi.spyOn(
    services.manager as never as {
      finishSegmentProcessing: (id: string) => void;
    },
    "finishSegmentProcessing",
  ).mockImplementation(() => {});
  const room = services.rooms.create({
    platform: "bilibili",
    url: "https://live.bilibili.com/123",
    displayName: "segments",
  });
  const rec = services.recordings.create({
    roomId: room.id,
    roomName: room.displayName,
    platform: room.platform,
    streamSessionId: null,
    streamTitle: "source",
  });
  const filePath = path.join(directory, "source.flv");
  await writeFile(filePath, "source");
  services.recordings.update(rec.id, {
    state: "completed",
    filePath,
    startedAt: new Date(Date.now() - 120000).toISOString(),
    metadata: { durationMs: 60000, segmentCount: 1, quality: null, size: 6 },
  });
  const a = services.recordingMarkers.create(rec.id, 1, "片段 1", 4);
  const b = services.recordingMarkers.create(rec.id, 5, "片段 2", 8);
  return { rec, a, b };
}
async function waitFor(fn: () => boolean) {
  await vi.waitFor(() => expect(fn()).toBe(true), {
    timeout: 5000,
    interval: 10,
  });
}
beforeEach(() => {
  exportFile.mockReset();
  exportFile.mockImplementation(async (_in: string, out: string) => {
    await writeFile(out, "clip");
    return { ok: true, sizeBytes: 4, stderr: "", actualEncoder: "copy" };
  });
});
afterEach(async () => {
  if (services) {
    await services.manager.shutdown();
    services.db.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe("persistent segments and task snapshots", () => {
  it("exports a temporary range through the same queue without creating or consuming markers", async () => {
    const { rec } = await setup();
    const before = services.recordingMarkers.list(rec.id);
    const batch = await services.clipQueueManager.submitRange(rec.id, 10.125, 15.25, "直接选区", "temporary-range");
    await waitFor(() => services.clipQueue.list(rec.id).every(item => item.state === "done"));
    expect(services.clipQueue.list(rec.id, batch)[0]).toMatchObject({
      markerId: null, startSecond: 10.125, endSecond: 15.25, fileName: "直接选区", state: "done",
    });
    expect(services.recordingMarkers.list(rec.id)).toEqual(before);
    expect(await services.clipQueueManager.submitRange(rec.id, 20, 25, "changed", "temporary-range")).toBe(batch);
    expect(exportFile).toHaveBeenCalledOnce();
    expect(services.clipQueue.list(rec.id)).toHaveLength(1);
  });
  it("validates selection bounds and names before creating a direct export task", async () => {
    const { rec } = await setup();
    for (const [start, end, name] of [[5, 4, "range"], [-1, 4, "range"], [1, 1.5, "range"], [50, 61, "range"], [1, 4, "bad/name"]] as const)
      await expect(services.clipQueueManager.submitRange(rec.id, start, end, name, `invalid-${start}-${end}-${name}`)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(services.clipQueue.list(rec.id)).toHaveLength(0);
  });
  it("accepts direct selection requests without marker IDs and preserves submitted bounds", async () => {
    const { rec } = await setup();
    const { app } = buildApp(services);
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/clip-queue/export-range", headers: { host: "127.0.0.1:43120" },
        payload: { recordingId: rec.id, startSecond: 7.125, endSecond: 12.25, name: "选区", requestId: "range-api" } });
      expect(response.statusCode).toBe(201);
      expect(response.json().items[0]).toMatchObject({ markerId: null, startSecond: 7.125, endSecond: 12.25, fileName: "选区" });
      const invalid = await app.inject({ method: "POST", url: "/api/v1/clip-queue/export-range", headers: { host: "127.0.0.1:43120" }, payload: {} });
      expect(invalid.statusCode).toBe(422);
    } finally { await app.close(); }
  });
  it("exports independent files and keeps reusable markers; repeating a request is idempotent", async () => {
    const { rec, a, b } = await setup();
    const batch = await services.clipQueueManager.submit(
      rec.id,
      [a.id, b.id],
      "request-1",
    );
    await waitFor(() =>
      services.clipQueue.list(rec.id).every((i) => i.state === "done"),
    );
    expect(
      await services.clipQueueManager.submit(rec.id, [a.id, b.id], "request-1"),
    ).toBe(batch);
    expect(services.clipQueue.list(rec.id)).toHaveLength(2);
    expect(exportFile).toHaveBeenCalledTimes(2);
    expect(services.recordingMarkers.list(rec.id)).toHaveLength(2);
    const rows = services.clipQueue.list(rec.id);
    expect(
      rows.every((i) => i.outputRecordingId && i.actualEncoder === "copy"),
    ).toBe(true);
    const outputs = rows.map(
      (i) => services.recordings.get(i.outputRecordingId!)!.filePath!,
    );
    expect(new Set(outputs).size).toBe(2);
    for (const output of outputs) expect((await stat(output)).size).toBe(4);
  });
  it("pages batches without loading the complete export history", async () => {
    const { rec, a } = await setup();
    for (let i = 0; i < 7; i++)
      services.clipQueue.createBatch(rec.id, `page-${i}`, [a], "auto");
    const first = services.clipQueue.page(rec.id, 1);
    const second = services.clipQueue.page(undefined, 2);
    expect(first.items).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(
      first.items.every((item) => item.recordingTitle === rec.streamTitle),
    ).toBe(true);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(7);
  });
  it("freezes submitted ranges and names, even when the marker is edited or deleted", async () => {
    const { rec, a } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    exportFile.mockImplementation(async (_in: string, out: string) => {
      await gate;
      await writeFile(out, "clip");
      return { ok: true, sizeBytes: 4, stderr: "" };
    });
    await services.clipQueueManager.submit(rec.id, [a.id], "snapshot");
    services.recordingMarkers.update(rec.id, a.id, {
      text: "changed",
      positionSeconds: 10,
      endPositionSeconds: 20,
    });
    services.recordingMarkers.remove(rec.id, a.id);
    expect(services.clipQueue.list(rec.id)[0]).toMatchObject({
      fileName: "片段 1",
      startSecond: 1,
      endSecond: 4,
    });
    release();
    await waitFor(() => services.clipQueue.list(rec.id)[0].state === "done");
  });
  it("does not label a real export failure as done, and isolates another successful segment", async () => {
    const { rec, a, b } = await setup();
    exportFile.mockResolvedValueOnce({
      ok: false,
      sizeBytes: 0,
      stderr: "failed encoder",
    });
    await services.clipQueueManager.submit(rec.id, [a.id, b.id], "failure");
    await waitFor(() =>
      services.clipQueue
        .list(rec.id)
        .every((i) => ["done", "failed"].includes(i.state)),
    );
    expect(services.clipQueue.list(rec.id).map((i) => i.state)).toEqual([
      "failed",
      "done",
    ]);
    expect(services.clipQueue.list(rec.id)[0].error).toBe("片段导出失败");
  });
  it("aborts the actual running job and cannot overwrite cancellation with done", async () => {
    const { rec, a } = await setup();
    let observedSignal: AbortSignal | undefined;
    exportFile.mockImplementation(
      async (
        _in: string,
        _out: string,
        _start: number,
        _end: number,
        options: { signal: AbortSignal },
      ) => {
        observedSignal = options.signal;
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return { ok: false, sizeBytes: 0, stderr: "aborted" };
      },
    );
    await services.clipQueueManager.submit(rec.id, [a.id], "cancel");
    await waitFor(() => !!observedSignal);
    const item = services.clipQueue.list(rec.id)[0];
    services.clipQueueManager.cancel(item.id);
    expect(services.clipQueue.get(item.id)?.state).toBe("cancelling");
    expect(observedSignal!.aborted).toBe(true);
    await waitFor(() => services.clipQueue.get(item.id)?.state === "cancelled");
    expect(services.recordingMarkers.list(rec.id)).toHaveLength(2);
  });
  it("waits for the shared export allowance instead of failing an entire batch", async () => {
    const { rec, a, b } = await setup();
    const occupied = (
      services.manager as never as { clipExports: Map<string, string> }
    ).clipExports;
    for (let i = 0; i < 6; i++) occupied.set(`manual-${i}`, `clip-${i}`);
    await services.clipQueueManager.submit(rec.id, [a.id, b.id], "capacity");
    expect(services.clipQueue.list(rec.id).map((i) => i.state)).toEqual([
      "queued",
      "queued",
    ]);
    expect(exportFile).not.toHaveBeenCalled();
    occupied.clear();
    await waitFor(() =>
      services.clipQueue.list(rec.id).every((i) => i.state === "done"),
    );
  });
  it("rejects an invalid member atomically and disallows point labels or foreign markers", async () => {
    const { rec, a } = await setup();
    const invalid = services.recordingMarkers.create(rec.id, 59, "invalid", 65);
    await expect(
      services.clipQueueManager.submit(rec.id, [a.id, invalid.id], "invalid"),
    ).rejects.toThrow("已录范围");
    expect(services.clipQueue.list()).toHaveLength(0);
    const point = services.recordingMarkers.create(rec.id, 3, "point");
    await expect(
      services.clipQueueManager.submit(rec.id, [point.id], "point"),
    ).rejects.toThrow("已保存的片段");
    await expect(
      services.clipQueueManager.submit(rec.id, ["foreign"], "foreign"),
    ).rejects.toThrow("已保存的片段");
  });
  it("retries with another output file without changing the persistent marker", async () => {
    const { rec, a } = await setup();
    exportFile.mockResolvedValueOnce({
      ok: false,
      sizeBytes: 0,
      stderr: "first failed",
    });
    await services.clipQueueManager.submit(rec.id, [a.id], "retry");
    const item = services.clipQueue.list(rec.id)[0];
    await waitFor(() => services.clipQueue.get(item.id)?.state === "failed");
    const previous = services.clipQueue.get(item.id)!.outputRecordingId;
    services.clipQueueManager.retry(item.id);
    await waitFor(() => services.clipQueue.get(item.id)?.state === "done");
    expect(services.clipQueue.get(item.id)!.outputRecordingId).not.toBe(
      previous,
    );
    expect(services.clipQueue.get(item.id)!.attempts).toBe(2);
  });
  it("scopes cancellation to a batch and preserves queued tasks across boot reconciliation", async () => {
    const { rec, a, b } = await setup();
    const batch = services.clipQueue.createBatch(
      rec.id,
      "boot",
      [a, b],
      "software",
    );
    const other = services.clipQueue.createBatch(rec.id, "other", [b], "auto");
    const items = services.clipQueue.list(undefined, batch);
    services.clipQueue.setState(items[0].id, "running");
    services.clipQueue.reconcileOnBoot();
    expect(services.clipQueue.get(items[0].id)?.state).toBe("interrupted");
    expect(services.clipQueue.get(items[1].id)?.state).toBe("queued");
    services.clipQueueManager.cancelPending(batch);
    expect(services.clipQueue.list(undefined, other)[0].state).toBe("queued");
  });
  it("stops running work before deleting a source and its task rows", async () => {
    const { rec, a } = await setup();
    let started = false;
    exportFile.mockImplementation(
      async (
        _in: string,
        _out: string,
        _s: number,
        _e: number,
        options: { signal: AbortSignal },
      ) => {
        started = true;
        await new Promise<void>((r) =>
          options.signal.addEventListener("abort", () => r(), { once: true }),
        );
        return { ok: false, sizeBytes: 0, stderr: "cancelled" };
      },
    );
    await services.clipQueueManager.submit(rec.id, [a.id], "delete");
    await waitFor(() => started);
    await services.clipQueueManager.removeByRecording(rec.id);
    expect(services.clipQueue.list(rec.id)).toEqual([]);
  });
  it("requires explicit selection and rejects legacy implicit export-all requests", async () => {
    await setup();
    const { app } = buildApp(services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/clip-queue/export-all",
        headers: { host: "127.0.0.1:43120" },
        payload: {},
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
describe("v48 compatibility", () => {
  it("promotes unsubmitted selections without destroying old labels or tasks", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)",
      );
      for (const m of MIGRATIONS.filter((m) => m.version <= 48)) {
        if (m.up) m.up(db);
        else if (m.sql) db.exec(m.sql);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
          m.version,
        );
      }
      db.prepare(
        "INSERT INTO recordings (id,room_id,room_name,platform,state,started_at) VALUES ('r','room','room','bilibili','completed','2026-01-01')",
      ).run();
      db.prepare(
        "INSERT INTO recording_markers (id,recording_id,position_seconds,text,created_at,updated_at) VALUES ('point','r',2,'label','now','now')",
      ).run();
      const insert = db.prepare(
        "INSERT INTO clip_queue (id,recording_id,start_second,end_second,file_name,encode_policy,state,sort_order,created_at) VALUES (?, 'r', 1, 3, 'segment', ?, ?, 1, 'now')",
      );
      insert.run("draft", null, "queued");
      insert.run("running", '{"encodingMode":"software"}', "running");
      expect(runMigrations(db)).toBe(1);
      expect(
        db
          .prepare(
            "SELECT end_position_seconds FROM recording_markers WHERE id='point'",
          )
          .get(),
      ).toEqual({ end_position_seconds: null });
      expect(
        db
          .prepare(
            "SELECT end_position_seconds FROM recording_markers WHERE id='mark_draft'",
          )
          .get(),
      ).toEqual({ end_position_seconds: 3 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM clip_queue").get()).toEqual({
        n: 1,
      });
      expect(runMigrations(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});
