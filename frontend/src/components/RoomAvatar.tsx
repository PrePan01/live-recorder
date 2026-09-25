import { useEffect, useState, type CSSProperties } from "react";
import type { Platform } from "../types/room";

/** B站 CDN 支持 @宽高 转换后缀；抖音 avatar_thumb 本身即小图，原链直取。 */
function thumbSrc(url: string, platform: Platform, size: number): string {
  if (platform === "bilibili" && !url.includes("@")) {
    const d = size * 2;
    return `${url}@${d}w_${d}h_1c_1s.webp`;
  }
  return url;
}

/**
 * 主播头像（监控卡片 + 历史列表共用）：
 * 有头像 → 懒加载圆形图（开播撞色环点亮）；无头像/加载失败 → 撞色圆底名首字兜底。
 * 历史数据无 avatarUrl 时零请求、不阻塞渲染；地址随检测周期更新时自动重试。
 */
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
  // 取首个完整码位（emoji/生僻字不截半个代理对）。
  const initial =
    [...(name ?? "").trim()][0] ||
    (platform === "bilibili" ? "B" : "抖");
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
