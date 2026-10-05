import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BufferedRecordingWriter,
  recordingSpoolDirectory,
  recoverRecordingBuffer,
  renameRecordingWithBuffer,
  listRecordingBufferTargets,
  removeRecordingBuffer,
  hasPendingRecordingBuffer,
} from "../../src/recorder/buffered-writer.js";

function slowTarget() {
  const bytes: Buffer[] = [];
  const callbacks: Array<() => void> = [];
  const target = new Writable({
    write(chunk, _encoding, callback) {
      bytes.push(Buffer.from(chunk));
      callbacks.push(() => callback());
    },
  });
  return {
    target: target as unknown as ReturnType<typeof createWriteStream>,
    bytes,
    callbacks,
  };
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
async function drain(callbacks: Array<() => void>, done: Promise<void>) {
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  for (let i = 0; !finished && i < 200; i++) {
    callbacks.shift()?.();
    await tick();
  }
  await done;
}

describe("ordered recording buffer", () => {
  it("spools a blocked target without dropping tags and commits only after target callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-"));
    const file = path.join(root, "video.flv");
    const { target, bytes, callbacks } = slowTarget();
    const writer = new BufferedRecordingWriter(target, file, {
      directory: root,
      memoryBytes: 12,
      spoolBytes: 100,
    });
    let committed = 0;
    for (let i = 0; i < 10; i++)
      await writer.write(Buffer.alloc(6, i), () => {
        committed += 6;
      });
    expect(committed).toBe(0);
    expect(writer.spooledBytes).toBeGreaterThan(0);
    expect(writer.pendingBytes).toBeLessThanOrEqual(12);
    await drain(callbacks, writer.close());
    expect(committed).toBe(60);
    expect(Buffer.concat(bytes)).toEqual(
      Buffer.concat(Array.from({ length: 10 }, (_, i) => Buffer.alloc(6, i))),
    );
    expect(
      (
        await readdir(recordingSpoolDirectory(root, file)).catch(
          () => [] as string[],
        )
      ).filter((x) => x.endsWith(".buffer")),
    ).toEqual([]);
  });

  it("applies backpressure when both buffers are full instead of discarding the next block", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-full-"));
    const { target, bytes, callbacks } = slowTarget();
    const writer = new BufferedRecordingWriter(target, path.join(root, "a"), {
      directory: root,
      memoryBytes: 6,
      spoolBytes: 0,
    });
    await writer.write(Buffer.from("first!"));
    let admitted = false;
    const blocked = writer.write(Buffer.from("second")).then(() => {
      admitted = true;
    });
    await tick();
    expect(admitted).toBe(false);
    callbacks.shift()!();
    await blocked;
    await drain(callbacks, writer.close());
    expect(Buffer.concat(bytes).toString()).toBe("first!second");
  });

  it("propagates asynchronous write errors and retains recoverable buffers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-error-"));
    const file = path.join(root, "a");
    const { target } = slowTarget();
    const writer = new BufferedRecordingWriter(target, file, {
      directory: root,
      memoryBytes: 12,
    });
    await writer.write(Buffer.from("first!"));
    await writer.write(Buffer.from("second"));
    const error = Object.assign(new Error("EIO"), { code: "EIO" });
    target.destroy(error);
    await tick();
    await expect(writer.close()).rejects.toThrow("EIO");
    expect(
      (await readdir(recordingSpoolDirectory(root, file))).filter((x) =>
        x.endsWith(".buffer"),
      ),
    ).toHaveLength(2);
  });

  it("replays partial target writes exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-replay-"));
    const file = path.join(root, "a");
    const { target } = slowTarget();
    const writer = new BufferedRecordingWriter(target, file, {
      directory: root,
      memoryBytes: 6,
    });
    await writer.write(Buffer.from("first!"));
    await writer.write(Buffer.from("second"));
    await writeFile(file, "fir");
    target.destroy(new Error("target offline"));
    await tick();
    await writer.close().catch(() => undefined);
    expect(await recoverRecordingBuffer(root, file)).toBe(9);
    expect((await readFile(file)).toString()).toBe("first!second");
    expect(await recoverRecordingBuffer(root, file)).toBe(0);
  });
});

it("preserves replay authority through confirmation renames and explicit deletion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-rename-"));
  const file = path.join(root, "pending.flv");
  const renamed = path.join(root, "confirmed.flv");
  await writeFile(file, "fir");
  const { target } = slowTarget();
  const writer = new BufferedRecordingWriter(target, file, {
    directory: root,
    recordingId: "recording-1",
  });
  await writer.write(Buffer.from("first!"));
  target.destroy(new Error("EIO"));
  await tick();
  await writer.close().catch(() => undefined);
  await renameRecordingWithBuffer(root, file, renamed);
  expect(await listRecordingBufferTargets(root)).toEqual([
    { recordingId: "recording-1", target: renamed },
  ]);
  expect(await recoverRecordingBuffer(root, renamed)).toBe(3);
  expect((await readFile(renamed)).toString()).toBe("first!");
  expect(hasPendingRecordingBuffer(root, renamed)).toBe(false);
  await removeRecordingBuffer(root, renamed);
});

it("retains a buffer with a missing prefix instead of inventing file content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-prefix-"));
  const file = path.join(root, "a");
  await writeFile(file, "abc");
  const directory = recordingSpoolDirectory(root, file);
  await mkdir(directory, { recursive: true });
  const spool = path.join(directory, "5-abcd.buffer");
  await writeFile(spool, "def");
  await expect(recoverRecordingBuffer(root, file)).rejects.toThrow(
    "缺少媒体数据",
  );
  expect((await readFile(file)).toString()).toBe("abc");
  expect((await readFile(spool)).toString()).toBe("def");
});

it("waits for an already-blocked admission before stopping the target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-close-"));
  const { target, bytes, callbacks } = slowTarget();
  const writer = new BufferedRecordingWriter(target, path.join(root, "a"), {
    directory: root,
    memoryBytes: 6,
    spoolBytes: 0,
  });
  await writer.write(Buffer.from("first!"));
  const next = writer.write(Buffer.from("second"));
  const closing = writer.close();
  callbacks.shift()!();
  await next;
  await drain(callbacks, closing);
  expect(Buffer.concat(bytes).toString()).toBe("first!second");
  await writer.close();
});

it("recovers a finished recording spool and keeps confirmation semantics", async () => {
  const { buildServices } = await import("../../src/core/services.js");
  const { recoverStaleRecordings } = await import("../../src/core/recovery.js");
  const root = await mkdtemp(path.join(tmpdir(), "lr-buffer-finished-"));
  const services = buildServices({ dbPath: path.join(root, "fixture.db") });
  const room = services.rooms.create({
    platform: "bilibili",
    url: "https://live.bilibili.com/123",
    displayName: "Recovery",
  });
  const rec = services.recordings.create({
    roomId: room.id,
    roomName: room.displayName,
    platform: "bilibili",
    streamSessionId: null,
    streamTitle: "Recovery",
  });
  const file = path.join(root, "a.flv");
  await writeFile(file, "fir");
  services.recordings.update(rec.id, {
    state: "awaiting_confirmation",
    filePath: file,
    fileSizeBytes: 3,
  });
  const { target } = slowTarget();
  const writer = new BufferedRecordingWriter(target, file, {
    directory: services.recordingBufferDirectory,
    recordingId: rec.id,
  });
  await writer.write(Buffer.from("first!"));
  target.destroy(new Error("EIO"));
  await tick();
  await writer.close().catch(() => undefined);
  await recoverStaleRecordings(services);
  expect((await readFile(file)).toString()).toBe("first!");
  expect(services.recordings.get(rec.id)!.fileSizeBytes).toBe(6);
  expect(services.recordings.get(rec.id)!.state).toBe("awaiting_confirmation");
  services.db.close();
});
