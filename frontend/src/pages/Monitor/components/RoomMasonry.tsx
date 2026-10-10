import { useLayoutEffect, useRef, type ReactNode } from "react";
import { layoutRoomMasonry } from "../../../utils/roomMasonry";

/** Keep DOM/sort order while placing each next card in the shortest column. */
export default function RoomMasonry({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const membership = useRef<{
    columns: number;
    ids: string[];
    assignments: number[];
  }>({ columns: 0, ids: [], assignments: [] });
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const items = Array.from(container.children) as HTMLElement[];
    const ids = items.map((item) => item.dataset.roomId ?? "");
    let frame = 0;
    const layout = () => {
      const columns =
        Number(
          getComputedStyle(container).getPropertyValue("--lr-masonry-columns"),
        ) || 1;
      const width = (container.clientWidth - (columns - 1) * 16) / columns;
      items.forEach((item) => {
        item.style.width = `${width}px`;
      });
      const previous = membership.current;
      // Height changes keep each room in its column. Reorder/filter/breakpoint
      // changes rebuild membership; progressive appends retain existing rooms.
      const keepColumns =
        previous.columns === columns &&
        previous.ids.length <= ids.length &&
        previous.ids.every((id, index) => id === ids[index]);
      const result = layoutRoomMasonry(
        items.map((item) => item.offsetHeight),
        columns,
        width,
        16,
        20,
        keepColumns ? previous.assignments : [],
      );
      membership.current = {
        columns,
        ids,
        assignments: result.columnAssignments,
      };
      items.forEach((item, index) => {
        item.style.left = `${result.positions[index].left}px`;
        item.style.top = `${result.positions[index].top}px`;
      });
      container.style.height = `${result.height}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    items.forEach((item) => observer.observe(item));
    window.addEventListener("resize", schedule);
    layout();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [children]);
  return (
    <div ref={ref} className="lr-room-masonry">
      {children}
    </div>
  );
}
