import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

function isBottomBorder(event: PointerEvent<HTMLElement>) {
  const panel = event.currentTarget;
  if (event.target !== panel) return false;
  const borderHeight = panel.offsetHeight - panel.clientHeight - panel.clientTop;
  const { bottom } = panel.getBoundingClientRect();
  return event.clientY >= bottom - borderHeight && event.clientY <= bottom;
}

export function useDanmakuListResize(
  panelRef: RefObject<HTMLElement | null>,
  playerRef: RefObject<HTMLDivElement | null>,
  open: boolean,
) {
  const [preferredHeight, setPreferredHeight] = useState<number>();
  const [bounds, setBounds] = useState<{ min: number; max: number }>();
  const drag = useRef<{ pointerId: number; y: number; height: number }>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const player = playerRef.current;
    if (!open || !panel || !player) return;
    const measure = () => {
      const max = player.offsetHeight;
      if (max === 0) return;
      const min = Math.min(max, Number.parseFloat(getComputedStyle(panel).minHeight));
      setBounds((previous) =>
        previous?.min === min && previous.max === max ? previous : { min, max },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(player);
    window.addEventListener("resize", measure);
    return () => {
      drag.current = null;
      panel.removeAttribute("data-resize-edge");
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, panelRef, playerRef]);

  const resize = (height: number) => {
    if (bounds) setPreferredHeight(Math.min(bounds.max, Math.max(bounds.min, height)));
  };
  const stop = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.removeAttribute("data-resize-edge");
  };

  return {
    preferredHeight,
    maxHeight: bounds?.max,
    resizeProps: {
      tabIndex: 0,
      "aria-description": "聚焦列表边框后，可用上下方向键调整列表高度",
      "aria-keyshortcuts": "ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Home End",
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (!open || event.button !== 0 || drag.current || !isBottomBorder(event)) return;
        const panel = event.currentTarget;
        panel.focus({ preventScroll: true });
        event.preventDefault();
        panel.setPointerCapture(event.pointerId);
        panel.setAttribute("data-resize-edge", "");
        drag.current = { pointerId: event.pointerId, y: event.clientY, height: panel.offsetHeight };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) {
          resize(start.height + event.clientY - start.y);
        } else if (!start) {
          event.currentTarget.toggleAttribute("data-resize-edge", isBottomBorder(event));
        }
      },
      onPointerLeave(event: PointerEvent<HTMLElement>) {
        if (!drag.current) event.currentTarget.removeAttribute("data-resize-edge");
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!bounds || event.target !== event.currentTarget) return;
        const step = event.shiftKey ? 48 : 12;
        const current = event.currentTarget.offsetHeight;
        if (event.key === "Home") setPreferredHeight(undefined);
        else if (event.key === "End") resize(bounds.max);
        else if (event.key === "ArrowUp") resize(current - step);
        else if (event.key === "ArrowDown") resize(current + step);
        else return;
        event.preventDefault();
      },
    },
  };
}
