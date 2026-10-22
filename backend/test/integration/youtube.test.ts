import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from "../../src/api/server.js";
import { buildServices } from "../../src/core/services.js";
import { YOUTUBE_COOKIE_KEY } from "../../src/security/keys.js";

describe("YouTube application integration", () => {
  let services: ReturnType<typeof buildServices>;
  beforeEach(() => {
    services = buildServices({ dbPath: ":memory:", mode: "fake" });
  });
  it('allows processing and renaming an earlier broadcast while the room records a new one', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lr-youtube-history-'));
    const room = services.rooms.create({ platform: 'youtube', url: 'https://youtube.com/watch?v=abcdefghijk', displayName: 'Creator' });
    const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'youtube', streamSessionId: 'abcdefghijk', streamTitle: 'old' });
    const file = path.join(directory, 'old.mkv');
    await writeFile(file, 'original media');
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    vi.spyOn(services.manager, 'isRoomActive').mockReturnValue(true);
    const retry = vi.spyOn(services.pipeline, 'retry').mockReturnValue({ ok: true, run: null });
    const { app } = buildApp(services);
    try {
      for (const action of ['retry', 'start']) {
        const result = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/${action}`, headers: { host: '127.0.0.1:43120' } });
        expect(result.statusCode).toBe(200);
      }
      expect(retry).toHaveBeenCalledTimes(2);
      const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/recordings/${rec.id}`, headers: { host: '127.0.0.1:43120' }, payload: { streamTitle: 'renamed' } });
      expect(renamed.statusCode).toBe(200);
      expect(services.recordings.get(rec.id)?.filePath).toBe(path.join(directory, 'renamed.mkv'));
      expect(await readFile(path.join(directory, 'renamed.mkv'), 'utf8')).toBe('original media');
      services.recordings.update(rec.id, { state: 'recording' });
      const active = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/pipeline/retry`, headers: { host: '127.0.0.1:43120' } });
      expect(active.statusCode).toBe(409);
      expect(retry).toHaveBeenCalledTimes(2);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("adds a canonical broadcast through the same room endpoint", async () => {
    const { app } = buildApp(services);
    const response = await app.inject({
      headers: { host: "127.0.0.1:43120" },
      method: "POST",
      url: "/api/v1/rooms",
      payload: { url: "https://youtu.be/abcdefghijk?si=tracking" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().room).toMatchObject({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const duplicate = await app.inject({
      headers: { host: "127.0.0.1:43120" },
      method: "POST",
      url: "/api/v1/rooms",
      payload: { url: "https://youtube.com/live/abcdefghijk" },
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });
  it("keeps credentials out of settings and configuration exports", async () => {
    const { app } = buildApp(services);
    const cookie =
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-cookie\n";
    const saved = await app.inject({
      headers: { host: "127.0.0.1:43120" },
      method: "POST",
      url: "/api/v1/settings/youtube-cookie",
      payload: { cookie },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.youtubeCookie).toEqual({ hasCookie: true });
    expect(saved.body).not.toContain("private-cookie");
    expect(services.settings.getRaw("settings") ?? "").not.toContain(
      "private-cookie",
    );
    expect(await services.secretStore.get(YOUTUBE_COOKIE_KEY)).toContain(
      "private-cookie",
    );
    const manual = await app.inject({
      headers: { host: "127.0.0.1:43120" },
      method: "PUT",
      url: "/api/v1/settings",
      payload: { youtubeCookie: cookie },
    });
    expect(manual.statusCode).toBe(422);
    expect(manual.json().error.message).toContain("一键授权");
    expect(await services.secretStore.get(YOUTUBE_COOKIE_KEY)).toContain("private-cookie");
    const cleared = await app.inject({
      headers: { host: "127.0.0.1:43120" },
      method: "PUT",
      url: "/api/v1/settings",
      payload: { youtubeCookie: "", recordingDirectory: tmpdir() },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().settings.youtubeCookie.hasCookie).toBe(false);
    await app.close();
  });
  it('supports YouTube statistics filters and naming previews', async () => {
    const { app } = buildApp(services);
    try {
      const stats = await app.inject({ url: '/api/v1/stats/recordings?platform=youtube', headers: { host: '127.0.0.1:43120' } });
      expect(stats.statusCode).toBe(200);
      const naming = await app.inject({ method: 'POST', url: '/api/v1/settings/naming-rule/preview', headers: { host: '127.0.0.1:43120' }, payload: { namingRule: '{platform}_{room}', platform: 'youtube', room: 'Creator' } });
      expect(naming.statusCode).toBe(200);
      expect(naming.json().example).toBe('youtube_Creator');
    } finally { await app.close(); }
  });
});

describe("permanent link failure surfacing", () => {
  it.each([
    ["未找到该频道或直播，请检查链接是否正确（重试不会恢复）", "missing link"],
    ["该频道没有直播内容，无法作为直播间添加（重试不会恢复）", "no live tab"],
  ])("reports %s on the first check without the vote gate", async (message, name) => {
    const services = buildServices({ dbPath: ":memory:", mode: "fake" });
    (services.adapterFor("youtube") as unknown as {
      setScript: (script: unknown[]) => void;
    }).setScript([
      {
        status: "error",
        error: {
          code: "ROOM_LINK_INVALID",
          message,
          roomId: null,
          recordingId: null,
          occurredAt: new Date().toISOString(),
          retryable: false,
        },
      },
    ]);
    const { app } = buildApp(services);
    try {
      const created = await app.inject({
        method: "POST", url: "/api/v1/rooms", headers: { host: "127.0.0.1:43120" },
        payload: { platform: "youtube", url: "https://www.youtube.com/watch?v=zzzzzzzzzzz", displayName: name },
      });
      expect(created.statusCode).toBe(201);
      const roomId = created.json().room.id;
      const checked = await app.inject({
        method: "POST", url: `/api/v1/rooms/${roomId}/check`, headers: { host: "127.0.0.1:43120" },
      });
      // 接口如实报错：解析失败不再回 ok。
      expect(checked.statusCode).toBeGreaterThanOrEqual(400);
      expect(checked.json().error.code).toBe("ROOM_LINK_INVALID");
      const room = services.rooms.get(roomId)!;
      // 首查即报：永久链接失败不等三票门，卡片状态与告警立即可见。
      expect(room.monitorState).toBe("failed");
      expect(room.lastError?.code).toBe("ROOM_LINK_INVALID");
      expect(room.lastError?.message).toBe(message);
      expect(services.alerts.list().some((alert) => alert.errorCode === "ROOM_LINK_INVALID")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
