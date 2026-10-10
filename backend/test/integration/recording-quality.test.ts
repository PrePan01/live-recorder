import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { buildServices } from "../../src/core/services.js";
import { FakeClock } from "../../src/core/clock.js";
import type { HealthProbe } from "../../src/core/quality-health.js";

describe("录制健康接口与告警", () => {
  it("批量和单条快照契约一致，结束后释放缓存，关闭时取消采样", async () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ":memory:", clock, mode: "fake" });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/123",
      displayName: "health",
    });
    const recording = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: null,
      streamTitle: "health",
    });
    let probes: HealthProbe[] = [
      {
        recordingId: recording.id,
        roomId: room.id,
        bytes: 1000,
        mediaTsMs: null,
        lastDataAt: clock.now(),
        writeError: false,
        qualityFallback: true,
      },
    ];
    vi.spyOn(services.manager, "healthProbe").mockImplementation(() => probes);
    const { app } = buildApp(services);
    try {
      clock.advance(3000);
      const request = {
        method: "GET" as const,
        headers: { host: "127.0.0.1:43120" },
      };
      const batch = await app.inject({
        ...request,
        url: "/api/v1/recordings/quality",
      });
      const single = await app.inject({
        ...request,
        url: `/api/v1/recordings/${recording.id}/quality`,
      });
      expect(batch.statusCode).toBe(200);
      expect(batch.json().health).toEqual([single.json()]);
      expect(single.json()).toMatchObject({
        lastDataAt: expect.any(Number),
        sampledAt: expect.any(Number),
        qualityFallback: true,
      });
      probes = [];
      clock.advance(3000);
      expect(
        (
          await app.inject({ ...request, url: "/api/v1/recordings/quality" })
        ).json().health,
      ).toEqual([]);
    } finally {
      await app.close();
    }
    expect(clock.pendingTimers()).toBe(0);
  });

  it("持续码率异常只提醒一次，恢复后告警自动收口", () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ":memory:", clock, mode: "fake" });
    let bytes = 1000;
    let media = 0;
    vi.spyOn(services.manager, "healthProbe").mockImplementation(() => [
      {
        recordingId: "r1",
        roomId: "room1",
        bytes,
        mediaTsMs: media,
        lastDataAt: clock.now(),
        writeError: false,
        qualityFallback: false,
      },
    ]);
    const advance = (ticks: number, delta: number) => {
      for (let i = 0; i < ticks; i++) {
        bytes += delta;
        media += 3000;
        clock.advance(3000);
      }
    };
    try {
      advance(12, 300000);
      advance(20, 10000);
      const alerts = services.alerts
        .list()
        .filter((a) => a.source === "stream-health");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].resolved).toBe(false);
      advance(3, 300000);
      expect(services.alerts.get(alerts[0].id)?.resolved).toBe(true);
    } finally {
      services.quality.stop();
      services.db.close();
    }
  });
});
