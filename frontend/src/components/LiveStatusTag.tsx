import { useLayoutEffect, useRef, useState } from "react";
import type { LiveStatus } from "../types/room";

const META: Record<LiveStatus, { colorClass: string; text: string }> = {
  live: { colorClass: "lr-live-status-text--live", text: "直播中" },
  offline: { colorClass: "lr-live-status-text--offline", text: "未开播" },
  restricted: { colorClass: "lr-live-status-text--restricted", text: "受限" },
};

export default function LiveStatusTag({
  status,
  streamTitle,
}: {
  status: LiveStatus | null;
  streamTitle?: string | null;
}) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const [marquee, setMarquee] = useState(false);
  const title = status === "live" ? streamTitle?.trim() : undefined;

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element || !title) {
      setMarquee(false);
      return;
    }
    const update = () => {
      const content = element.querySelector<HTMLElement>(
        ".lr-live-status-title__content",
      );
      const viewport = element.querySelector<HTMLElement>(
        ".lr-live-status-title__viewport",
      );
      const contentWidth =
        content?.getBoundingClientRect().width ?? element.scrollWidth;
      const viewportWidth = viewport?.clientWidth ?? element.clientWidth;
      setMarquee(contentWidth > viewportWidth + 0.5);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const viewport = element.querySelector<HTMLElement>(
      ".lr-live-status-title__viewport",
    );
    if (viewport) observer.observe(viewport);
    update();
    return () => observer.disconnect();
  }, [title]);

  if (!status) {
    return (
      <span className="lr-live-status-tag">
        <span className="lr-live-status-dot lr-live-status-dot--offline" />
        <span className="lr-live-status-text lr-live-status-text--offline">
          未检测
        </span>
      </span>
    );
  }
  const meta = META[status];
  return (
    <span className="lr-live-status-tag">
      <span className={`lr-live-status-dot lr-live-status-dot--${status}`} />
      <span className={`lr-live-status-text ${meta.colorClass}`}>
        {meta.text}
      </span>
      {title ? (
        <span
          ref={titleRef}
          className="lr-live-status-title"
          title={`当前直播标题：${title}`}
          aria-label={`当前直播标题：${title}`}
        >
          <span className="lr-live-status-title__viewport">
            {marquee ? (
              <span className="lr-live-status-title__marquee">
                <span className="lr-live-status-title__content">{title}</span>
                <span aria-hidden="true">{title}</span>
              </span>
            ) : (
              <span className="lr-live-status-title__content">{title}</span>
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}
