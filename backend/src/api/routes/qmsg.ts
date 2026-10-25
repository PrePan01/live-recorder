import type { FastifyInstance } from "fastify";
import type { Services } from "../../core/services.js";
import { AppError } from "../../types/error.js";
import { DEFAULT_SETTINGS } from "../../config/defaults.js";
import { QMSG_KEY } from "../../security/keys.js";
import { settingsView } from "./settings-view.js";

export function registerQmsgRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  const view = async () => ({
    enabled: services.settings.load()?.qmsg?.enabled ?? false,
    keySet: await services.secretStore.has(QMSG_KEY),
  });
  app.get("/api/v1/settings/qmsg", async () => ({ qmsg: await view() }));
  app.put("/api/v1/settings/qmsg", async (req) => {
    const body = req.body as {
      enabled?: unknown;
      key?: unknown;
      clearKey?: unknown;
    } | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
      (body.key !== undefined &&
        (typeof body.key !== "string" ||
          !/^[a-zA-Z0-9_-]{1,256}$/.test(body.key))) ||
      (body.clearKey !== undefined && typeof body.clearKey !== "boolean") ||
      (body.key !== undefined && body.clearKey === true)
    ) {
      throw new AppError(
        "CONFIG_INVALID",
        "QQ 通知配置无效，请填写有效 Key 或明确清除凭据",
      );
    }
    const current =
      services.settings.load() ?? structuredClone(DEFAULT_SETTINGS);
    const oldKey = await services.secretStore.get(QMSG_KEY);
    try {
      if (body.clearKey === true) await services.secretStore.delete(QMSG_KEY);
      else if (typeof body.key === "string")
        await services.secretStore.set(QMSG_KEY, body.key);
      services.settings.save({
        ...current,
        qmsg: {
          enabled:
            (body.enabled as boolean | undefined) ??
            current.qmsg?.enabled ??
            false,
        },
      });
    } catch {
      try {
        if (oldKey === null) await services.secretStore.delete(QMSG_KEY);
        else await services.secretStore.set(QMSG_KEY, oldKey);
      } catch {
        /* Keep error responses independent of secret-store implementation details. */
      }
      throw new AppError(
        "CONFIG_LOAD_FAILED",
        "QQ 通知配置保存失败，请检查凭据存储",
      );
    }
    services.qmsg.invalidate();
    services.events.emit({
      type: "settings:updated",
      data: await settingsView(services),
    });
    return { qmsg: await view() };
  });
  app.post("/api/v1/settings/qmsg/test", async () => {
    if (!(await services.secretStore.has(QMSG_KEY)))
      throw new AppError(
        "CONFIG_INVALID",
        "请先保存 Qmsg Key 并完成机器人绑定",
      );
    if (services.qmsg.busy)
      throw new AppError("DIAGNOSTIC_CONFLICT", "QQ 推送队列忙，请稍后测试");
    try {
      const result = await services.qmsg.enqueue(
        "直播录制助手：这是一条 QQ 通知测试消息",
      );
      if (result !== "submitted") throw new Error("skipped");
      return { ok: true, status: "submitted" };
    } catch {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "QQ 推送提交失败，请检查 Qmsg 绑定、额度与网络",
      );
    }
  });
}
