import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
import os from "node:os";
import { buildServices, type Services } from "../../src/core/services.js";
import { buildApp } from "../../src/api/server.js";
import { FakeClock } from "../../src/core/clock.js";
import {
  isScreenshotPng,
  MAX_SCREENSHOT_BYTES,
  writeScreenshot,
} from "../../src/api/routes/room-screenshots.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "screenshots-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const services = buildServices({
    dbPath: ":memory:",
    mode: "fake",
    clock: new FakeClock(Date.parse("2026-10-22T12:34:56.789Z")),
  });
  services.settings.save({
    ...services.manager.settings(),
    recordingDirectory: directory,
  });
  const room = services.rooms.create({
    platform: "bilibili",
    url: "https://live.bilibili.com/1",
    displayName: "主播",
  });
  const { app } = buildApp(services);
  cleanups.push(async () => {
    await app.close();
    services.db.close();
  });
  const save = (suffix = "", bytes = png) =>
    app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.id}/screenshots${suffix}`,
      headers: { host: "127.0.0.1:43120", "content-type": "image/png" },
      payload: bytes,
    });
  return { directory, services, room, app, save };
}
function recording(services: Services, roomId: string, filePath: string) {
  const rec = services.recordings.create({
    roomId,
    roomName: "主播",
    platform: "bilibili",
    streamTitle: "test",
    quality: "original",
  });
  services.recordings.update(rec.id, { filePath });
  return rec.id;
}

describe("preview screenshots", () => {
  it("creates the room screenshot folder without starting a recording and writes original PNG bytes", async () => {
    const { directory, services, room, save } = await setup();
    const response = await save();
    expect(response.statusCode).toBe(200);
    const filePath = response.json().filePath;
    expect(path.dirname(filePath)).toBe(
      path.join(directory, "bilibili", "主播", "截图"),
    );
    expect(path.basename(filePath)).toMatch(/^截图_\d{8}_\d{6}_789\.png$/);
    expect(await readFile(filePath)).toEqual(png);
    expect(services.manager.activeRecordingFor(room.id)).toBeNull();
  });
  it("uses the associated recording directory even after settings and room name change", async () => {
    const { directory, services, room, save } = await setup();
    const id = recording(
      services,
      room.id,
      path.join(directory, "original", "recording.flv"),
    );
    services.rooms.update(room.id, { displayName: "新名字" });
    services.settings.save({
      ...services.manager.settings(),
      recordingDirectory: "",
    });
    const response = await save(`?recordingId=${id}`);
    expect(response.statusCode).toBe(200);
    expect(path.dirname(response.json().filePath)).toBe(
      path.join(directory, "original", "截图"),
    );
  });
  it("resolves the current active recording when the client sends no recording ID", async () => {
    const { directory, services, room, save } = await setup();
    const id = recording(
      services,
      room.id,
      path.join(directory, "active", "recording.mkv"),
    );
    vi.spyOn(services.manager, "activeRecordingFor").mockReturnValue({
      recordingId: id,
      startedAt: services.clock.iso(),
    });
    const response = await save();
    expect(response.statusCode).toBe(200);
    expect(path.dirname(response.json().filePath)).toBe(
      path.join(directory, "active", "截图"),
    );
  });
  it("never overwrites concurrent captures with identical timestamps", async () => {
    const { save } = await setup();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => save()),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const paths = responses.map((r) => r.json().filePath as string);
    expect(new Set(paths).size).toBe(5);
    for (const file of paths) expect(await readFile(file)).toEqual(png);
  });
  it("rejects missing or foreign recordings, and recordings without a file path", async () => {
    const { services, room, save } = await setup();
    const other = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/2",
      displayName: "other",
    });
    const foreign = recording(services, other.id, "/tmp/foreign.flv");
    const pending = services.recordings.create({
      roomId: room.id,
      roomName: "主播",
      platform: "bilibili",
      streamTitle: "test",
      quality: "original",
    });
    expect((await save("?recordingId=missing")).statusCode).toBe(404);
    expect((await save(`?recordingId=${foreign}`)).statusCode).toBe(404);
    expect((await save(`?recordingId=${pending.id}`)).json().error.code).toBe(
      "RECORDING_DIRECTORY_INVALID",
    );
  });
  it("rejects absent configuration and unwritable output without leaving a screenshot", async () => {
    const { directory, services, save } = await setup();
    services.settings.save({
      ...services.manager.settings(),
      recordingDirectory: "",
    });
    expect((await save()).json().error.message).toContain("配置录像保存目录");
    const blocker = path.join(directory, "file");
    await writeFile(blocker, "not a directory");
    services.settings.save({
      ...services.manager.settings(),
      recordingDirectory: blocker,
    });
    expect((await save()).json().error.code).toBe("DIRECTORY_NOT_WRITABLE");
    expect(await readdir(directory)).toEqual(["file"]);
  });
  it("rejects malformed and oversized images and missing rooms", async () => {
    const { app, save } = await setup();
    for (const bytes of [
      Buffer.from("not png"),
      png.subarray(0, 40),
      Buffer.concat([png, Buffer.from("extra")]),
    ]) {
      expect((await save("", bytes)).statusCode).toBe(422);
    }
    const oversized = await save("", Buffer.alloc(MAX_SCREENSHOT_BYTES + 1));
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.message).toContain("32 MiB");
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/rooms/missing/screenshots",
      headers: { "content-type": "image/png", host: "127.0.0.1:43120" },
      payload: png,
    });
    expect(missing.statusCode).toBe(404);
  });
  it("checks PNG chunk lengths and nonzero dimensions", () => {
    expect(isScreenshotPng(png)).toBe(true);
    const invalid = Buffer.from(png);
    invalid.writeUInt32BE(0, 16);
    expect(isScreenshotPng(invalid)).toBe(false);
    invalid.writeUInt32BE(0xffffffff, 8);
    expect(isScreenshotPng(invalid)).toBe(false);
  });
  it.each(["ENOSPC", "EACCES"])(
    "cleans up partially written files after %s",
    async (code) => {
      const { directory, save } = await setup();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      vi.mocked(fs.open).mockImplementationOnce(
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await actual.open(...args);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await actual.writeFile(args[0], "partial");
            throw Object.assign(new Error(code), { code });
          });
          return handle;
        },
      );
      const response = await save();
      expect(response.json().error.code).toBe(
        code === "ENOSPC"
          ? "DISK_SPACE_INSUFFICIENT"
          : "DIRECTORY_NOT_WRITABLE",
      );
      expect(
        await readdir(path.join(directory, "bilibili", "主播", "截图")),
      ).toEqual([]);
    },
  );
  it("reports filesystem errors when creating a screenshot directory", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "screenshot-write-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const blocker = path.join(directory, "file");
    await writeFile(blocker, "block");
    await expect(
      writeScreenshot(
        path.join(blocker, "截图"),
        png,
        new Date().toISOString(),
      ),
    ).rejects.toMatchObject({ code: "DIRECTORY_NOT_WRITABLE" });
  });
});
