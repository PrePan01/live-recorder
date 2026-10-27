import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TIMELINE_VISUAL_OVERFLOW,
  timelineTicks,
  visibleTimelineLabels,
  zoomTimeline,
} from "../../utils/timeline/timelineZoom";

export function useTimelineZoom(timelineEnd: number, dragging: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [width, setWidth] = useState(1);
  const pendingScroll = useRef<number | null>(null);
  const changeZoom = useCallback(
    (delta: number, clientX?: number) => {
      const viewport = viewportRef.current;
      if (!viewport || dragging || timelineEnd <= 0) return;
      const rect = viewport.getBoundingClientRect();
      const scale =
        viewport.offsetWidth > 0 ? rect.width / viewport.offsetWidth : 1;
      const contentWidth = Math.max(
        1,
        viewport.clientWidth - TIMELINE_VISUAL_OVERFLOW * 2,
      );
      const next = zoomTimeline(
        zoom,
        delta,
        contentWidth,
        viewport.scrollLeft,
        clientX == null
          ? contentWidth / 2
          : (clientX - rect.left) / scale - TIMELINE_VISUAL_OVERFLOW,
        timelineEnd,
      );
      pendingScroll.current = next.scrollLeft;
      setZoom(next.zoom);
    },
    [zoom, dragging, timelineEnd],
  );
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && pendingScroll.current != null) {
      viewport.scrollLeft = pendingScroll.current;
      setScrollLeft(viewport.scrollLeft);
      pendingScroll.current = null;
    }
  }, [zoom]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      setWidth(
        Math.max(1, viewport.clientWidth - TIMELINE_VISUAL_OVERFLOW * 2),
      );
      setScrollLeft(viewport.scrollLeft);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      // 横向滚轮和 Shift+滚轮用于平移，普通纵向滚轮以指针为中心缩放。
      event.preventDefault();
      if (dragging) return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientWidth
            : 1;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        viewport.scrollLeft += (event.deltaX || event.deltaY) * unit;
      } else if (event.deltaY) changeZoom(event.deltaY * unit, event.clientX);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom, dragging]);
  const resetZoom = () => {
    pendingScroll.current = 0;
    setZoom(1);
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
    setScrollLeft(0);
  };
  const ticks = useMemo(
    () =>
      timelineTicks(
        timelineEnd,
        zoom,
        (scrollLeft / (width * zoom)) * timelineEnd,
        Math.max(2, Math.floor(width / 90)),
      ),
    [timelineEnd, zoom, scrollLeft, width],
  );
  useLayoutEffect(() => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const update = () => {
      const labels = Array.from(
        ruler.querySelectorAll<HTMLSpanElement>("[data-timeline-second]"),
      );
      const visible = visibleTimelineLabels(
        labels.map((label) => {
          const rect = label.getBoundingClientRect();
          return {
            second: Number(label.dataset.timelineSecond),
            left: rect.left,
            right: rect.right,
          };
        }),
        timelineEnd,
      );
      for (const label of labels)
        label.style.visibility = visible.has(
          Number(label.dataset.timelineSecond),
        )
          ? ""
          : "hidden";
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ruler);
    for (const label of ruler.children) observer.observe(label);
    return () => observer.disconnect();
  }, [ticks, timelineEnd]);
  return {
    viewportRef,
    rulerRef,
    zoom,
    changeZoom,
    resetZoom,
    onScroll: () => setScrollLeft(viewportRef.current?.scrollLeft ?? 0),
    ticks,
  };
}
