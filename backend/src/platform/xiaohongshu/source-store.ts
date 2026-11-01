// 保存“小红书主播主页 → 直播间”的对应关系
import type { DB } from "../../db/connection.js";
import { XiaohongshuSourceRepository } from "../../db/repositories/xiaohongshu-source.repo.js";
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from "./url.js";

/** Move the tracked broadcast while retaining its local room ID and all history. */
export function saveXiaohongshuSource(
  db: DB,
  profile: string,
  raw: string,
): void {
  if (
    parseXiaohongshuUrl(profile)?.kind !== "profile" ||
    parseXiaohongshuUrl(raw)?.kind !== "room"
  )
    return;
  new XiaohongshuSourceRepository(db).save(profile, normalizeXiaohongshuUrl(raw));
}
