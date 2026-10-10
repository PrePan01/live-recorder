import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildServices } from "../../src/core/services.js";
import { buildApp } from "../../src/api/server.js";
import { keptMarkerSidecarPath } from "../../src/storage/recording-markers.js";
let services: ReturnType<typeof buildServices>;
let app: ReturnType<typeof buildApp>["app"];
let dir: string;
let id: string;
let file: string;
const headers = { host: "127.0.0.1:43120" };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lr-marker-segment-"));
  services = buildServices({ dbPath: ":memory:" });
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
    streamTitle: "video",
  });
  id = rec.id;
  file = path.join(dir, "video.flv");
  await writeFile(file, "video");
  services.recordings.update(id, {
    state: "completed",
    filePath: file,
    metadata: { durationMs: 30000, segmentCount: 1, quality: null, size: 5 },
  });
  app = buildApp(services).app;
});
afterEach(async () => {
  await app.close();
  await services.manager.shutdown();
  services.db.close();
  await rm(dir, { recursive: true, force: true });
});
const create = (payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/api/v1/recordings/${id}/markers`,
    headers,
    payload,
  });
describe("point labels and persistent range markers share the API", () => {
  it("preserves click-time subsecond precision when saving and editing a point label", async () => {
    const response = await create({ text: "accurate", positionSeconds: 10.125 });
    expect(response.statusCode).toBe(201);
    const marker = response.json().marker;
    expect(marker.positionSeconds).toBe(10.125);
    expect(services.recordingMarkers.get(id, marker.id)?.positionSeconds).toBe(10.125);
    const edited = await app.inject({ method: "PATCH", url: `/api/v1/recordings/${id}/markers/${marker.id}`,
      headers, payload: { text: "renamed" } });
    expect(edited.json().marker.positionSeconds).toBe(10.125);
  });
  it("creates, edits, moves and deletes historical markers and stores the range sidecar", async () => {
    const point = await create({ text: "label", positionSeconds: 2 });
    expect(point.statusCode).toBe(201);
    const response = await create({
      text: "片段 1",
      positionSeconds: 3.25,
      endPositionSeconds: 8.5,
    });
    expect(response.statusCode).toBe(201);
    const marker = response.json().marker;
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/recordings/${id}/markers/${marker.id}`,
      headers,
      payload: { text: "changed", positionSeconds: 5, endPositionSeconds: 9 },
    });
    expect(edited.json().marker).toMatchObject({
      text: "changed",
      positionSeconds: 5,
      endPositionSeconds: 9,
    });
    const sidecar = JSON.parse(
      await readFile(keptMarkerSidecarPath(file), "utf8"),
    );
    expect(sidecar.markers[1]).toMatchObject({
      text: "changed",
      startSecond: 5,
      endSecond: 9,
    });
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/v1/recordings/${id}/markers/${point.json().marker.id}`,
      headers,
      payload: { positionSeconds: 4 },
    });
    expect(moved.statusCode).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/recordings/${id}/markers/${marker.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(services.recordingMarkers.list(id)).toHaveLength(1);
  });
  it.each([
    { positionSeconds: 8, endPositionSeconds: 3 },
    { positionSeconds: 3, endPositionSeconds: 3 },
    { positionSeconds: 3, endPositionSeconds: 3.5 },
    { positionSeconds: -1, endPositionSeconds: 3 },
    { positionSeconds: 20, endPositionSeconds: 31 },
    { positionSeconds: "3", endPositionSeconds: 8 },
  ])(
    "rejects invalid or out-of-media-range selections: %j",
    async (payload) => {
      const response = await create({ text: "invalid", ...payload });
      expect(response.statusCode).toBe(422);
      expect(services.recordingMarkers.list(id)).toHaveLength(0);
    },
  );
  it("keeps marker types fixed and validates the complete range on either boundary edit", async () => {
    const point = (await create({ text: "point", positionSeconds: 2 })).json()
      .marker;
    const segment = (
      await create({
        text: "segment",
        positionSeconds: 5,
        endPositionSeconds: 8,
      })
    ).json().marker;
    for (const [marker, payload] of [
      [point, { endPositionSeconds: 5 }],
      [segment, { endPositionSeconds: null }],
      [segment, { positionSeconds: 8 }],
      [segment, { endPositionSeconds: 31 }],
    ] as const) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/recordings/${id}/markers/${marker.id}`,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
    expect(services.recordingMarkers.get(id, segment.id)).toMatchObject({
      positionSeconds: 5,
      endPositionSeconds: 8,
    });
  });
  it("returns a bounded playback position and does not expose wall-clock duration as media duration", async () => {
    const response = await app.inject({
      url: `/api/v1/recordings/${id}/marker-position?lagSeconds=3`,
      headers,
    });
    expect(response.json()).toEqual({
      durationSeconds: 30,
      positionSeconds: 27,
      previewOffsetSeconds: null,
    });
  });
});
