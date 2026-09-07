import { Tag } from "antd";
import type { Platform } from "../types/room";

const PLATFORM_STYLE: Record<
  Platform,
  { color: string; bg: string; label: string; icon: string }
> = {
  bilibili: {
    color: "#fb7299",
    bg: "rgba(251,114,153,0.12)",
    label: "B站",
    icon: "https://www.bilibili.com/favicon.ico",
  },
  douyin: {
    color: "#161823",
    bg: "rgba(22,24,35,0.06)",
    label: "抖音",
    icon: "https://www.douyin.com/favicon.ico",
  },
};

export function PlatformIcon({
  platform,
  size = 16,
}: {
  platform: Platform;
  size?: number;
}) {
  const style = PLATFORM_STYLE[platform];
  return (
    <img
      className="lr-platform-icon"
      src={style.icon}
      alt={`${style.label}图标`}
      width={size}
      height={size}
    />
  );
}

export function PlatformLogoTag({
  platform,
  isShowName,
}: {
  platform: Platform;
  isShowName?: boolean;
}) {
  const style = PLATFORM_STYLE[platform];
  return (
    <Tag
      className="lr-platform-logo-tag"
      style={{
        background: style.bg,
        borderColor: "transparent",
        borderRadius: 4,
      }}
    >
      <PlatformIcon platform={platform} size={16} />
      <span
        className="lr-platform-logo-tag__label"
        style={{
          color: style.color,
          fontWeight: 600,
          display: isShowName ? "block" : "none",
        }}
      >
        {style.label}
      </span>
    </Tag>
  );
}
