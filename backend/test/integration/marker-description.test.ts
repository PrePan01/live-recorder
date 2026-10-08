import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { buildServices } from "../../src/core/services.js";
import { buildApp } from "../../src/api/server.js";
import {
  keptMarkerSidecarPath,
  liveMarkerSidecarPath,
} from "../../src/storage/recording-markers.js";

describe("录制结束后补写标记说明", () => {
  it("只修改文字，同步保留目录中的标签，禁止移动和新增标记", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lr-marker-description-"),
    );
    const services = buildServices({ dbPath: ":memory:", mode: "fake" });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/123",
      displayName: "markers",
    });
    const rec = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: null,
      streamTitle: "markers",
    });
    const filePath = path.join(directory, "video.flv");
    services.recordings.update(rec.id, { state: "completed", filePath });
    const marker = services.recordingMarkers.create(rec.id, 10, "标记 1");
    const { app } = buildApp(services);
    const request = { headers: { host: "127.0.0.1:43120" } };
    const url = `/api/v1/recordings/${rec.id}/markers`;
    try {
      const response = await app.inject({
        ...request,
        method: "PATCH",
        url: `${url}/${marker.id}`,
        payload: { text: "精彩片段" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().marker).toMatchObject({
        text: "精彩片段",
        positionSeconds: 10,
      });
      const sidecar = JSON.parse(
        await readFile(keptMarkerSidecarPath(filePath), "utf8"),
      );
      expect(sidecar.markers[0]).toMatchObject({
        text: "精彩片段",
        time: "10秒",
      });
      expect(
        await stat(liveMarkerSidecarPath(filePath)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      for (const payload of [
        { positionSeconds: 20 },
        { text: "移动", positionSeconds: 20 },
        {},
      ]) {
        const moved = await app.inject({
          ...request,
          method: "PATCH",
          url: `${url}/${marker.id}`,
          payload,
        });
        expect(moved.json().error.code).toBe("RECORDING_NOT_AVAILABLE");
      }
      const created = await app.inject({
        ...request,
        method: "POST",
        url,
        payload: { text: "新增" },
      });
      expect(created.json().error.code).toBe("RECORDING_NOT_AVAILABLE");
      const invalid = await app.inject({
        ...request,
        method: "PATCH",
        url: `${url}/${marker.id}`,
        payload: { text: " " },
      });
      expect(invalid.json().error.code).toBe("CONFIG_INVALID");
      expect(services.recordingMarkers.list(rec.id)[0]).toMatchObject({
        positionSeconds: 10,
        text: "精彩片段",
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("长时间断流后直播打点落文件尾，禁止移到尚不存在的媒体位置", async () => {
    const clock = new FakeClock(Date.now());
    const services = buildServices({ dbPath: ":memory:", mode: "fake", clock });
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/123",
      displayName: "tail",
    });
    const rec = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: null,
      streamTitle: "tail",
    });
    services.recordings.update(rec.id, { state: "reconnecting" });
    clock.advance(120000);
    const session: {
      recordingId: string;
      roomId: string;
      mediaPositionMs?: number;
      size: number;
      startedAt: string;
      missingMs: number;
      gapStartAt: number;
    } = {
      recordingId: rec.id,
      roomId: room.id,
      mediaPositionMs: 12345,
      size: 1000,
      startedAt: rec.startedAt,
      missingMs: 30000,
      gapStartAt: clock.now() - 30000,
    };
    (
      services.manager as unknown as { active: Map<string, unknown> }
    ).active.set(room.id, session);
    const { app } = buildApp(services);
    const url = `/api/v1/recordings/${rec.id}/markers`;
    const request = { headers: { host: "127.0.0.1:43120" } };
    try {
      const created = await app.inject({
        ...request,
        method: "POST",
        url,
        payload: { text: "精彩" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().marker.positionSeconds).toBe(12);
      const moved = await app.inject({
        ...request,
        method: "PATCH",
        url: `${url}/${created.json().marker.id}`,
        payload: { positionSeconds: 60 },
      });
      expect(moved.json().error.code).toBe("CONFIG_INVALID");
      session.mediaPositionMs = undefined;
      expect(
        services.manager.recordingMarkerTail(room.id, rec.id),
      ).toBeGreaterThanOrEqual(59);
      expect(
        services.manager.recordingMarkerTail(room.id, rec.id),
      ).toBeLessThanOrEqual(60);
      session.size = 0;
      expect(services.manager.recordingMarkerTail(room.id, rec.id)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
