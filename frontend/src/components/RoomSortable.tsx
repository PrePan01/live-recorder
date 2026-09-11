import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  createContext,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { Room } from "../types/room";
import { reorderVisibleRooms } from "../utils/roomOrder";

const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [role=button], [contenteditable=true], .ant-select, .ant-checkbox-wrapper, .ant-switch";

type SortMode = "card" | "table";
const SortContext = createContext<{ disabled: boolean }>({ disabled: false });

export function RoomSortableProvider({
  allRooms,
  visibleRooms,
  mode,
  disabled = false,
  onReorder,
  children,
}: {
  allRooms: Room[];
  visibleRooms: Room[];
  mode: SortMode;
  disabled?: boolean;
  onReorder: (roomIds: string[]) => Promise<void>;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
  );
  const visibleIds = visibleRooms.map((room) => room.id);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || disabled) return;
    const sourceId = String(active.id);
    const targetId = String(over.id);
    const sourceIndex = visibleIds.indexOf(sourceId);
    const targetIndex = visibleIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = reorderVisibleRooms(
      allRooms,
      visibleIds,
      sourceId,
      targetId,
      sourceIndex < targetIndex ? "after" : "before",
    );
    if (next !== allRooms) void onReorder(next.map((room) => room.id));
  };

  return (
    <SortContext.Provider value={{ disabled }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        autoScroll={{
          acceleration: 18,
          interval: 5,
          threshold: { x: 0.1, y: 0.1 },
        }}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleIds}
          strategy={
            mode === "card" ? rectSortingStrategy : verticalListSortingStrategy
          }
        >
          {children}
        </SortableContext>
      </DndContext>
    </SortContext.Provider>
  );
}

// oxlint-disable-next-line react/only-export-components -- the hook shares this provider's private context
export function useRoomSortableItem(id: string, mode: SortMode) {
  const { disabled } = useContext(SortContext);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled,
    transition: { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const origin = event.target as HTMLElement;
    const interactive = origin.closest(INTERACTIVE_SELECTOR);
    if (interactive && interactive !== event.currentTarget) return;
    if (mode === "card" && !origin.closest(".ant-card-head")) return;
    if (mode === "table" && !origin.closest("tr, td")) return;
    listeners?.onPointerDown?.(event);
  };

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.38 : undefined,
    position: "relative",
    zIndex: isDragging ? 4 : undefined,
  };

  return {
    setNodeRef,
    style,
    attributes,
    listeners: listeners ? { ...listeners, onPointerDown } : { onPointerDown },
    isDragging,
  };
}

export function SortableRoomTableRow(
  props: HTMLAttributes<HTMLTableRowElement> & { "data-row-key"?: string },
) {
  const id = String(props["data-row-key"] ?? "");
  const sortable = useRoomSortableItem(id, "table");
  /* oxlint-disable react/refs -- dnd-kit exposes callback refs and reactive sortable values */
  return (
    <tr
      {...props}
      {...sortable.attributes}
      role="row"
      {...sortable.listeners}
      ref={sortable.setNodeRef}
      style={{ ...props.style, ...sortable.style }}
      className={`${props.className ?? ""} lr-sortable-row ${sortable.isDragging ? "lr-sort-dragging" : ""}`}
    />
  );
  /* oxlint-enable react/refs */
}
