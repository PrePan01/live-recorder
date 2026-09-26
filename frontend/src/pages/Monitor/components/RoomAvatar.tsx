import { useEffect, useState, type CSSProperties } from "react";
import type { Platform } from "../../../types/room";

function thumbSrc(url: string, platform: Platform, size: number): string {
  if (platform === "bilibili" && !url.includes("@")) {
    const d = Math.max(size * 2, 240);
    return `${url}@${d}w_${d}h_1c_1s.webp`;
  }
  if (platform === "douyin") {
    return url
      .replace(/\/avatar_(?:thumb|medium)(?=\/|$)/, "/avatar_larger")
      .replace(/\/aweme\/\d+x\d+\//, "/aweme/1080x1080/");
  }
  return url;
}

export default function RoomAvatar({
  platform,
  avatarUrl,
  name,
  live = false,
  size = 32,
  className,
}: {
  platform: Platform;
  avatarUrl?: string | null;
  name?: string;
  live?: boolean;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);

  const show = Boolean(avatarUrl) && !failed;
  const initial =
    [...(name ?? "").trim()][0] || (platform === "bilibili" ? "B" : "抖");
  const classes = [
    "lr-room-avatar",
    `lr-room-avatar--${platform}`,
    show ? "" : "lr-room-avatar--fallback",
    live ? "lr-room-avatar--live" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      style={{ "--lr-avatar-size": `${size}px` } as CSSProperties}
      role="img"
      aria-label={name ? `${name} 的头像` : "主播头像"}
    >
      {show ? (
        <img
          src={thumbSrc(avatarUrl!, platform, size)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={size}
          height={size}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}
