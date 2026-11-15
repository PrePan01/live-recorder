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
  titleOnly = false,
  onTitleClick,
}: {
  status: LiveStatus | null;
  streamTitle?: string | null;
  titleOnly?: boolean;
  onTitleClick?: (title: string) => void;
}) {
  const titleRef = useRef<HTMLElement>(null);
  const [marquee, setMarquee] = useState(false);
  const title = status === "live" ? streamTitle?.trim() : undefined;
  const Title = onTitleClick ? "button" : "span";
  const titleLabel = onTitleClick ? "复制直播标题" : "当前直播标题";

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
  }, [title, Title]);

  if (!status) {
    if (titleOnly) return null;
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
      {!titleOnly ? (
        <>
          <span
            className={`lr-live-status-dot lr-live-status-dot--${status}`}
          />
          <span className={`lr-live-status-text ${meta.colorClass}`}>
            {meta.text}
          </span>
        </>
      ) : null}
      {title ? (
        <Title
          ref={(element: HTMLElement | null) => {
            titleRef.current = element;
          }}
          className="lr-live-status-title"
          title={`${titleLabel}：${title}`}
          aria-label={`${titleLabel}：${title}`}
          type={onTitleClick ? "button" : undefined}
          onClick={onTitleClick ? () => onTitleClick(title) : undefined}
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
        </Title>
      ) : null}
    </span>
  );
}
