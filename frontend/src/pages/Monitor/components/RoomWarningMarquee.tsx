import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { WarningOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";

export interface RoomWarning {
  text: string;
  action?: { label: string; to: string };
  suffix?: string;
}

export default function RoomWarningMarquee({
  messages,
}: {
  messages: RoomWarning[];
}) {
  const navigate = useNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(6);
  const text = messages
    .map(
      ({ text, action, suffix }) =>
        `${text}${action?.label ?? ""}${suffix ?? ""}`,
    )
    .join(" · ");

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const update = () => {
      viewport.style.setProperty(
        "--lr-warning-width",
        `${viewport.clientWidth}px`,
      );
      setDuration(content.offsetWidth / 110);
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    update();
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      className="lr-room-warning"
      role="status"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <WarningOutlined aria-label="警告" />
      <div
        ref={viewportRef}
        className="lr-room-warning__viewport"
        tabIndex={0}
        title={text}
        aria-label={`直播间警告：${text}`}
      >
        <div
          className="lr-room-warning__track"
          style={{ "--lr-warning-duration": `${duration}s` } as CSSProperties}
        >
          {[0, 1].map((copy) => (
            <div
              key={copy}
              ref={copy === 0 ? contentRef : undefined}
              className="lr-room-warning__group"
              aria-hidden={copy === 1 ? true : undefined}
            >
              {messages.map((message, index) => (
                <span key={index} className="lr-room-warning__message">
                  {index > 0 ? "　·　" : null}
                  {message.text}
                  {message.action ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="lr-room-warning__action"
                        tabIndex={copy === 1 ? -1 : 0}
                        onClick={() => navigate(message.action!.to)}
                      >
                        {message.action.label}
                      </button>{" "}
                    </>
                  ) : null}
                  {message.suffix}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
