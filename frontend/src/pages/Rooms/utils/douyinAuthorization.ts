import type { App } from "antd";
import { fetchDouyinCookieStatus } from "../../../api/settings";

export async function promptDouyinAuthorization(
  message: ReturnType<typeof App.useApp>["message"],
) {
  const status = await fetchDouyinCookieStatus().catch(() => "unknown" as const);
  if (status === "missing" || status === "invalid") {
    message.warning("如需观看、录制抖音直播间，请在设置内登录并授权", 5);
  }
}
