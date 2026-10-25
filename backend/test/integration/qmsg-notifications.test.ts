import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { buildServices } from "../../src/core/services.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";
import { QMSG_KEY } from "../../src/security/keys.js";
import { normalizeNotifications } from "../../src/config/notifications.js";
const headers = { host: "127.0.0.1:43120" };
function setup() {
  const services = buildServices({ dbPath: ":memory:" });
  services.settings.save({
    ...structuredClone(DEFAULT_SETTINGS),
    recordingDirectory: "/tmp/notification-test",
  });
  const { app } = buildApp(services);
  return {
    services,
    app,
    call: (method: "GET" | "PUT" | "POST", path: string, payload?: unknown) =>
      app.inject({
        method,
        url: `/api/v1/${path}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      }),
  };
}
describe("notification configuration API", () => {
  it("upgrades legacy preferences and preserves partial edits across all channels", async () => {
    const { services, app, call } = setup();
    try {
      services.settings.setRaw(
        "settings",
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          notifications: {
            desktopEnabled: false,
            liveStarted: true,
            dedupeWindowMinutes: 20,
          },
        }),
      );
      const legacy = (await call("GET", "settings/notifications")).json()
        .notifications;
      expect(Object.values(legacy.desktop)).toEqual(Array(8).fill(false));
      expect(Object.values(legacy.qq)).toEqual(Array(8).fill(true));
      expect(legacy.email.pipelineCompleted).toBe(false);
      expect(
        normalizeNotifications({ recordingFailed: false }).desktop
          .recordingFailed,
      ).toBe(false);
      const response = await call("PUT", "settings/notifications", {
        qq: { liveStarted: false },
        desktop: { pipelineCompleted: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().notifications.qq.recordingStarted).toBe(true);
      expect(response.json().notifications.desktop.pipelineCompleted).toBe(
        true,
      );
      expect(response.json().notifications.dedupeWindowMinutes).toBe(20);
      for (const patch of [
        { qq: false },
        { qq: { recordingStarted: 1 } },
        { dedupeWindowMinutes: 1.5 },
      ]) {
        expect(
          (await call("PUT", "settings/notifications", patch)).statusCode,
        ).toBe(422);
      }
      expect(
        normalizeNotifications({
          desktop: { liveStarted: false },
          email: { recordingFailed: false },
        }).qq.liveStarted,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("stores keys only in SecretStore, tests independently of enabled, clears and exports safely", async () => {
    const { services, app, call } = setup();
    try {
      expect((await call("POST", "settings/qmsg/test")).statusCode).toBe(422);
      const write = await call("PUT", "settings/qmsg", {
        key: "private-qmsg-key",
        enabled: true,
      });
      expect(write.statusCode).toBe(200);
      expect(write.json()).toEqual({ qmsg: { enabled: true, keySet: true } });
      expect(await services.secretStore.get(QMSG_KEY)).toBe("private-qmsg-key");
      expect(services.settings.getRaw("settings")).not.toContain(
        "private-qmsg-key",
      );
      for (const path of ["settings", "settings/qmsg", "config/export"]) {
        expect((await call("GET", path)).body).not.toContain(
          "private-qmsg-key",
        );
      }
      const test = await call("POST", "settings/qmsg/test");
      expect(test.json()).toEqual({ ok: true, status: "submitted" });
      await call("PUT", "settings/qmsg", { enabled: false });
      expect(await services.secretStore.has(QMSG_KEY)).toBe(true);
      await call("PUT", "settings/qmsg", { clearKey: true });
      expect(await services.secretStore.has(QMSG_KEY)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed writes and rolls back credentials when settings persistence fails", async () => {
    const { services, app, call } = setup();
    try {
      await call("PUT", "settings/qmsg", { key: "old-key" });
      for (const patch of [
        { key: "https://bad" },
        { enabled: "yes" },
        { key: "new-key", clearKey: true },
        [],
      ]) {
        expect((await call("PUT", "settings/qmsg", patch)).statusCode).toBe(
          422,
        );
      }
      const save = vi
        .spyOn(services.settings, "save")
        .mockImplementationOnce(() => {
          throw new Error("private-qmsg-key");
        });
      const failed = await call("PUT", "settings/qmsg", {
        key: "new-key",
        enabled: true,
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      expect(failed.body).not.toContain("private-qmsg-key");
      expect(await services.secretStore.get(QMSG_KEY)).toBe("old-key");
      save.mockRestore();
      await call("POST", "settings/reset", {
        confirm: "RESET",
        keepRecordings: true,
      });
      expect(await services.secretStore.has(QMSG_KEY)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("imports non-secret settings and strips key material from ordinary settings writes", async () => {
    const { services, app, call } = setup();
    try {
      const response = await call("PUT", "settings", {
        qmsg: { enabled: true, key: "injected-secret", keySet: true },
      });
      expect(response.statusCode).toBe(200);
      expect(services.settings.getRaw("settings")).not.toContain(
        "injected-secret",
      );
      const config = (await call("GET", "config/export")).json().config;
      const imported = await call("POST", "config/import", { config });
      expect(
        imported.statusCode,
        imported.body + JSON.stringify(services.alerts.list()),
      ).toBe(200);
      expect((await call("GET", "settings")).json().settings.qmsg).toEqual({
        enabled: true,
        keySet: false,
      });
    } finally {
      await app.close();
    }
  });
});
