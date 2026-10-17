import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { buildServices } from "../../src/core/services.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";
import { runMigrations } from "../../src/db/migrations/index.js";

const headers = { host: "127.0.0.1:43120" };
function setup() {
  const services = buildServices({ dbPath: ":memory:" });
  services.settings.save({
    ...structuredClone(DEFAULT_SETTINGS),
    recordingDirectory: "/tmp/lr-room-policy",
  });
  return { services, app: buildApp(services).app };
}

describe("room policy persistence and compatibility", () => {
  it("merges all historical channel combinations once and preserves later opt-outs", async () => {
    const { services, app } = setup();
    const combinations = [[false, false], [true, false], [false, true], [true, true]] as const;
    const rooms = combinations.map(([desktop, email], index) => services.rooms.create({
      platform: "bilibili", url: `https://live.bilibili.com/${900 + index}`,
      displayName: `legacy-${index}`, liveNotificationEnabled: desktop, liveEmailNotificationEnabled: email,
    }));
    services.db.exec("DELETE FROM schema_version WHERE version=55");
    expect(runMigrations(services.db)).toBe(1);
    rooms.forEach((room, index) => {
      expect(services.rooms.get(room.id)).toMatchObject({
        liveNotificationEnabled: combinations[index]![0] || combinations[index]![1],
        liveEmailNotificationEnabled: false,
      });
    });
    services.rooms.update(rooms[2]!.id, { liveNotificationEnabled: false });
    expect(runMigrations(services.db)).toBe(0);
    expect(services.rooms.get(rooms[2]!.id)!.liveNotificationEnabled).toBe(false);
    await app.close();
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "merges legacy backup subscriptions desktop=%s email=%s for new and existing rooms",
    async (desktop, email) => {
      const { services, app } = setup();
      const config = { rooms: [{ platform: "bilibili", url: "https://live.bilibili.com/910",
        liveNotificationEnabled: desktop, liveEmailNotificationEnabled: email }] };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: "POST", url: "/api/v1/config/import", headers, payload: { config } });
        expect(response.statusCode).toBe(200);
        expect(services.rooms.list()).toHaveLength(1);
        expect(services.rooms.list()[0]).toMatchObject({
          liveNotificationEnabled: desktop || email, liveEmailNotificationEnabled: false,
        });
      }
      await app.close();
    },
  );

  it("round-trips an explicitly disabled reminder without reviving a legacy email bit", async () => {
    const source = setup();
    source.services.rooms.create({ platform: "bilibili", url: "https://live.bilibili.com/911",
      displayName: "disabled reminder", liveNotificationEnabled: false, liveEmailNotificationEnabled: true });
    const config = (await source.app.inject({ method: "GET", url: "/api/v1/config/export", headers })).json().config;
    const target = setup();
    const response = await target.app.inject({ method: "POST", url: "/api/v1/config/import", headers, payload: { config } });
    expect(response.statusCode).toBe(200);
    expect(target.services.rooms.list()[0]).toMatchObject({ liveNotificationEnabled: false, liveEmailNotificationEnabled: false });
    await source.app.close();
    await target.app.close();
  });
  it("upgrades historical rows idempotently without freezing inherited values", async () => {
    const { services, app } = setup();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/1",
      displayName: "old",
    });
    services.db.exec(
      "ALTER TABLE rooms DROP COLUMN quality; ALTER TABLE rooms DROP COLUMN check_interval_sec; DELETE FROM schema_version WHERE version=53",
    );
    expect(runMigrations(services.db)).toBe(1);
    expect(runMigrations(services.db)).toBe(0);
    expect(services.rooms.get(room.id)).toMatchObject({
      quality: null,
      checkIntervalSec: null,
      displayName: "old",
    });
    services.settings.save({ ...services.settings.load()!, quality: "540p" });
    expect(services.rooms.get(room.id)!.quality).toBeNull();
    await app.close();
  });

  it("upgrades email preferences with a disabled default and preserves omitted edits", async () => {
    const { services, app } = setup();
    const old = services.rooms.create({ platform: "bilibili", url: "https://live.bilibili.com/101", displayName: "old" });
    services.db.exec("ALTER TABLE rooms DROP COLUMN live_email_notification_enabled; DELETE FROM schema_version WHERE version=54");
    expect(runMigrations(services.db)).toBe(1);
    expect(runMigrations(services.db)).toBe(0);
    expect(services.rooms.get(old.id)!.liveEmailNotificationEnabled).toBe(false);
    const events: unknown[] = [];
    services.events.on(event => { if (event.type === "room:updated") events.push(event.data); });
    const enabled = await app.inject({ method: "PATCH", url: `/api/v1/rooms/${old.id}`, headers, payload: { liveEmailNotificationEnabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(events.at(-1)).toMatchObject({ liveEmailNotificationEnabled: true });
    await app.inject({ method: "PATCH", url: `/api/v1/rooms/${old.id}`, headers, payload: { displayName: "renamed" } });
    expect(services.rooms.get(old.id)!.liveEmailNotificationEnabled).toBe(true);
    const created = await app.inject({ method: "POST", url: "/api/v1/rooms", headers, payload: { url: "https://live.bilibili.com/102", displayName: "new", enabled: false, liveEmailNotificationEnabled: true } });
    expect(created.json().room.liveEmailNotificationEnabled).toBe(true);
    await app.close();
  });

  it("creates, patches, preserves omitted fields and restores inheritance in API and SSE", async () => {
    const { services, app } = setup();
    const events: unknown[] = [];
    services.events.on((event) => {
      if (event.type === "room:updated") events.push(event.data);
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers,
      payload: {
        url: "https://live.bilibili.com/2",
        displayName: "custom",
        enabled: false,
        checkIntervalSec: 15,
        quality: "540p",
        autoRecord: false,
        danmakuEnabled: true,
      },
    });
    expect(response.statusCode).toBe(201);
    const room = response.json().room;
    expect(room).toMatchObject({
      quality: "540p",
      checkIntervalSec: 15,
      enabled: false,
      danmakuEnabled: true,
    });
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${room.id}`,
      headers,
      payload: { displayName: "renamed" },
    });
    expect(update.json().room).toMatchObject({
      quality: "540p",
      checkIntervalSec: 15,
    });
    const reset = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${room.id}`,
      headers,
      payload: { quality: null, checkIntervalSec: null },
    });
    expect(reset.json().room).toMatchObject({
      quality: null,
      checkIntervalSec: null,
    });
    expect(events.at(-1)).toMatchObject({
      id: room.id,
      quality: null,
      checkIntervalSec: null,
    });
    await app.close();
  });

  it.each([
    { checkIntervalSec: 9 },
    { checkIntervalSec: 10.5 },
    { checkIntervalSec: "60" },
    { checkIntervalSec: Number.MAX_SAFE_INTEGER + 1 },
    { quality: "4k" },
    { enabled: null },
    { liveEmailNotificationEnabled: null },
    { liveEmailNotificationEnabled: "true" },
  ])("rejects invalid policies without saving: %j", async (invalid) => {
    const { services, app } = setup();
    const room = services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/3",
      displayName: "valid",
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/rooms/${room.id}`,
      headers,
      payload: { displayName: "bad", ...invalid },
    });
    expect(response.statusCode).toBe(422);
    expect(services.rooms.get(room.id)!.displayName).toBe("valid");
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      headers,
      payload: {
        url: "https://live.bilibili.com/4",
        displayName: "bad",
        ...invalid,
      },
    });
    expect(create.statusCode).toBe(422);
    expect(services.rooms.list()).toHaveLength(1);
    await app.close();
  });

  it("round-trips all six settings and preserves existing policy on legacy import", async () => {
    const source = setup();
    const policy = {
      enabled: false,
      autoRecord: true,
      danmakuEnabled: false,
      liveNotificationEnabled: true,
      liveEmailNotificationEnabled: false,
      checkIntervalSec: 37,
      quality: "1080p" as const,
    };
    source.services.rooms.create({
      platform: "bilibili",
      url: "https://live.bilibili.com/5",
      displayName: "backup",
      ...policy,
    });
    const exported = (
      await source.app.inject({
        method: "GET",
        url: "/api/v1/config/export",
        headers,
      })
    ).json().config;
    const target = setup();
    const imported = await target.app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers,
      payload: { config: exported },
    });
    expect(imported.statusCode).toBe(200);
    expect(target.services.rooms.list()[0]).toMatchObject(policy);
    const legacy = {
      rooms: [
        { platform: "bilibili", url: "https://live.bilibili.com/5" },
        { platform: "douyin", url: "https://live.douyin.com/6" },
      ],
    };
    expect(
      (
        await target.app.inject({
          method: "POST",
          url: "/api/v1/config/import",
          headers,
          payload: { config: legacy },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      target.services.rooms.list().find((room) => room.platform === "bilibili"),
    ).toMatchObject(policy);
    expect(
      target.services.rooms.list().find((room) => room.platform === "douyin"),
    ).toMatchObject({ quality: null, checkIntervalSec: null, liveEmailNotificationEnabled: false });
    await source.app.close();
    await target.app.close();
  });
});
