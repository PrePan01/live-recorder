import type { Room } from "../../../types/room";

function guessPlatform(url: string): Room["platform"] | null {
  if (/live\.douyin\.com|douyin\.com/.test(url)) return "douyin";
  if (/live\.bilibili\.com|bilibili\.com/.test(url)) return "bilibili";
  return null;
}

const PLATFORM_LABEL: Record<Room["platform"], string> = {
  bilibili: "B站",
  douyin: "抖音",
};

export { guessPlatform, PLATFORM_LABEL };
