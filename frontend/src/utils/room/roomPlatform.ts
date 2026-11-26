import type { Room } from "../../types/room";

function guessPlatform(url: string): Room["platform"] | null {
  try {
    const host = new URL(url).hostname;
    if (["douyu.com", "www.douyu.com", "m.douyu.com"].includes(host)) return "douyu";
    if (["huya.com", "www.huya.com", "m.huya.com"].includes(host)) return "huya";
    if (["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
    if (host === "douyin.com" || host.endsWith(".douyin.com")) return "douyin";
    if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return "bilibili";
    if (
      ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.com"].includes(
        host,
      )
    )
      return "xiaohongshu";
  } catch {
    /* not a URL */
  }
  return null;
}

const PLATFORM_LABEL: Record<Room["platform"], string> = {
  bilibili: "B站",
  douyin: "抖音",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  douyu: "斗鱼",
  huya: "虎牙",
};

export const PLATFORM_OPTIONS = (Object.keys(PLATFORM_LABEL) as Room["platform"][])
  .map(value => ({ value, label: PLATFORM_LABEL[value] }));

export { guessPlatform, PLATFORM_LABEL };

/** Legacy profiles without a discovered broadcast must not masquerade as live-room links. */
export function roomLivePageUrl(room: Pick<Room, "platform" | "url" | "liveRoomUrl">): string | undefined {
  const url = room.liveRoomUrl ?? room.url;
  if (room.platform !== "xiaohongshu") return url;
  try {
    const parsed = new URL(url);
    return ["www.xiaohongshu.com", "xiaohongshu.com"].includes(parsed.hostname) && /^\/livestream\/\d+(?:\/|$)/.test(parsed.pathname) ? url : undefined;
  } catch { return undefined; }
}
