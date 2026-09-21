import { describe, expect, it } from "vitest";
import {
  boundedDiagnosticLog,
  createDiagnosticBundle,
  performanceDiagnosticSummary,
  redactDiagnosticText,
  roomDiagnosticSnapshots,
} from "../../src/api/diagnostic-bundle.js";
import { buildServices } from "../../src/core/services.js";
import { FakeClock } from "../../src/core/clock.js";

describe("diagnostic bundle privacy boundary", () => {
  it("redacts secrets, URLs, email addresses, paths, and caller-supplied sensitive values", () => {
    const value = redactDiagnosticText(
      "Cookie: SESSDATA=secret Authorization: Bearer abc https://example.test/live?token=abc alice@example.test /Users/alice/Movies/custom-name",
      ["custom-name"],
    );
    expect(value).not.toContain("SESSDATA");
    expect(value).not.toContain("abc");
    expect(value).not.toContain("example.test");
    expect(value).not.toContain("alice@example.test");
    expect(value).not.toContain("/Users/alice");
    expect(value).not.toContain("custom-name");
  });

  it("keeps only public room identifiers and support-safe fields", () => {
    const services = buildServices({
      dbPath: ":memory:",
      clock: new FakeClock(),
    });
    services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/12345",
      displayName: "私密名称",
    });
    const rooms = roomDiagnosticSnapshots(services);
    expect(rooms).toEqual([
      expect.objectContaining({ platform: "bilibili", publicRoomId: "12345" }),
    ]);
    expect(JSON.stringify(rooms)).not.toContain("私密名称");
    expect(JSON.stringify(rooms)).not.toContain("live.bilibili.com");
  });

  it("caps logs at one MiB and retains their tail", () => {
    const oversized = Buffer.concat([
      Buffer.alloc(1_048_576, "a"),
      Buffer.from("TAIL"),
    ]);
    const result = boundedDiagnosticLog(oversized);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1_048_576);
    expect(result.endsWith("TAIL")).toBe(true);
  });

  it("exports startup timings without local room identifiers", () => {
    const exported = performanceDiagnosticSummary([
      {
        id: 1,
        kind: "preview_start",
        roomId: "room_private_123",
        platform: "bilibili",
        startedAt: "2026-09-21T00:00:00.000Z",
        elapsedMs: 345,
        outcome: "ok",
        stages: [{ name: "stream_url_ready", elapsedMs: 200 }],
        errorCode: null,
      },
    ]);
    expect(JSON.stringify(exported)).not.toContain("room_private_123");
    expect(exported).toEqual([
      expect.objectContaining({ elapsedMs: 345, platform: "bilibili" }),
    ]);
  });

  it("creates every fixed ZIP entry even when both backend logs are absent", async () => {
    const services = buildServices({
      dbPath: ":memory:",
      clock: new FakeClock(),
    });
    const archive = await createDiagnosticBundle(services, {
      stateDir: "/private/tmp/live-recorder-no-diagnostic-logs",
      frontendDiagnostics: [{ source: "test", message: "Cookie: secret" }],
    });
    const directory = archive.toString("latin1");
    for (const entry of [
      "README.txt",
      "runtime.json",
      "rooms.json",
      "frontend-errors.json",
      "startup-performance.json",
      "backend.log",
      "backend.previous.log",
    ]) {
      expect(directory).toContain(entry);
    }
    expect(archive.subarray(0, 2).toString()).toBe("PK");
  });

  it("omits every room entry when room diagnostics are declined", async () => {
    const services = buildServices({
      dbPath: ":memory:",
      clock: new FakeClock(),
    });
    services.rooms.create({
      platform: "douyin",
      url: "https://live.douyin.com/12345",
      displayName: "不应导出",
    });
    const archive = await createDiagnosticBundle(services, {
      stateDir: "/private/tmp/live-recorder-no-diagnostic-logs",
      includeRooms: false,
    });
    const directory = archive.toString("latin1");
    expect(directory).not.toContain("rooms.json");
    expect(directory).toContain("README.txt");
  });
});
