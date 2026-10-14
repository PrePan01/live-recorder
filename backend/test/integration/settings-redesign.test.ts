import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { buildServices } from "../../src/core/services.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";
import {
  DOUYIN_COOKIE_KEY,
  BILIBILI_COOKIE_KEY,
} from "../../src/security/keys.js";
const headers = { host: "127.0.0.1:43120" };
function setup() {
  const services = buildServices({ dbPath: ":memory:" });
  services.settings.save({
    ...structuredClone(DEFAULT_SETTINGS),
    recordingDirectory: "/tmp/settings-redesign-recordings",
  });
  const { app } = buildApp(services);
  return { services, app };
}
describe("settings redesign API", () => {
  it("rejects fractional recording concurrency and platform intervals without persisting them", async () => {
    const { services, app } = setup();
    for (const patch of [
      { maxConcurrentRecordings: 1.5 },
      ...["default", "bilibili", "douyin"].map(platform => ({ checkIntervalSec: { [platform]: 10.5 } })),
    ]) {
      const before = services.settings.load();
      const res = await app.inject({ method: "PUT", url: "/api/v1/settings", headers, payload: patch });
      expect(res.statusCode).toBe(422);
      expect(services.settings.load()).toEqual(before);
    }
    await app.close();
  });
  it("rejects malformed nested patches without changing other settings", async () => {
    const { services, app } = setup();
    for (const patch of [
      { checkIntervalSec: null },
      { checkIntervalSec: [] },
      { danmaku: { enabled: "yes" } },
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers,
        payload: { theme: "dark", ...patch },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(services.settings.load()!.theme).toBe("system");
    }
    await app.close();
  });
  it("returns authoritative defaults without paths, account configuration or secrets", async () => {
    const { services, app } = setup();
    services.settings.save({ ...services.settings.load()!, theme: "dark" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/defaults",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { defaults } = res.json();
    expect(defaults.settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(defaults.settings.checkIntervalSec).toEqual(
      DEFAULT_SETTINGS.checkIntervalSec,
    );
    expect(defaults.pipeline.exportCover).toBe(
      DEFAULT_SETTINGS.pipeline.exportCover,
    );
    expect(defaults.settings).not.toHaveProperty("recordingDirectory");
    expect(defaults.settings).not.toHaveProperty("mail");
    expect(defaults.pipeline).not.toHaveProperty("archiveDirectory");
    expect(defaults.email).toEqual({ enabled: false });
    await app.close();
  });
  it("merges one platform interval without overwriting its siblings or other domains", async () => {
    const { services, app } = setup();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { checkIntervalSec: { douyin: 90 } },
    });
    expect(res.statusCode).toBe(200);
    expect(services.settings.load()!.checkIntervalSec).toEqual({
      ...DEFAULT_SETTINGS.checkIntervalSec,
      douyin: 90,
    });
    expect(services.settings.load()!.theme).toBe("system");
    await app.close();
  });
  it("rejects invalid credentials before saving ordinary settings", async () => {
    const { services, app } = setup();
    for (const key of ["douyinCookie", "bilibiliCookie"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers,
        payload: { theme: "dark", [key]: "invalid" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(services.settings.load()!.theme).toBe("system");
    }
    expect(await services.secretStore.has(DOUYIN_COOKIE_KEY)).toBe(false);
    expect(await services.secretStore.has(BILIBILI_COOKIE_KEY)).toBe(false);
    await app.close();
  });
  it("preserves existing secrets on unrelated changes and clears only explicitly requested secrets", async () => {
    const { services, app } = setup();
    await services.secretStore.set(DOUYIN_COOKIE_KEY, "existing-cookie");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { danmaku: { enabled: true } },
    });
    expect(saved.statusCode).toBe(200);
    expect(await services.secretStore.get(DOUYIN_COOKIE_KEY)).toBe(
      "existing-cookie",
    );
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers,
      payload: { douyinCookie: "" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(await services.secretStore.has(DOUYIN_COOKIE_KEY)).toBe(false);
    expect(services.settings.load()!.danmaku?.enabled).toBe(true);
    await app.close();
  });
});
