import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { SwapOutlined, VideoCameraAddOutlined } from "@ant-design/icons";
import type { Room } from "../../types/room";
import {
  getWallCapacity,
  useWallStore,
  type WallGrid as GridLayout,
} from "../../stores/wallStore";
import WallLiveCard from "../WallLiveCard";
import styles from "./index.module.css";
import { stableSlotEntries } from "./slots";

interface WallGridProps {
  rooms: Room[];
  grid: GridLayout;
  onFullscreen: (room: Room) => void;
  onRemove: (room: Room) => void;
}

export default function WallGrid({
  rooms,
  grid,
  onFullscreen,
  onRemove,
}: WallGridProps) {
  const moveRoomToSlot = useWallStore((s) => s.moveRoomToSlot);
  const roomIds = useWallStore((s) => s.roomIds);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const positions = useRef(new Map<string, DOMRect>());
  const columns = grid === "2x2" ? 2 : 3;
  const occupiedLength = roomIds.reduce(
    (length, id, index) => (id ? index + 1 : length),
    0,
  );
  const slots = Array.from(
    { length: Math.max(getWallCapacity(grid), occupiedLength) },
    (_, index) => rooms.find((room) => room.id === roomIds[index]),
  );

  useLayoutEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.current.forEach((element, id) => {
        const before = positions.current.get(id);
        if (!before) return;
        const after = element.getBoundingClientRect();
        const x = before.left - after.left;
        const y = before.top - after.top;
        if (x || y) {
          element.animate(
            [
              { transform: `translate(${x}px, ${y}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          );
        }
      });
    }
    positions.current.clear();
  }, [rooms, roomIds]);

  const swap = (source: string, target: number) => {
    positions.current.clear();
    elements.current.forEach((element, id) =>
      positions.current.set(id, element.getBoundingClientRect()),
    );
    moveRoomToSlot(source, target);
  };

  const resetDrag = () => {
    setSourceId(null);
    setTargetId(null);
  };

  const startDrag = (event: DragEvent<HTMLDivElement>, room: Room) => {
    if (
      (event.target as HTMLElement).closest(
        "button, a, input, select, textarea",
      )
    ) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", room.id);
    const element = elements.current.get(room.id);
    if (element) {
      const rect = element.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        element,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    }
    setSourceId(room.id);
  };

  return (
    <div
      className={`lr-wall-grid ${styles.grid}`}
      style={
        {
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          "--wall-rows": Math.ceil(slots.length / columns),
        } as CSSProperties
      }
    >
      {stableSlotEntries(slots).map(({ room, index, key }) => (
        <div
          style={{
            gridRow: Math.floor(index / columns) + 1,
            gridColumn: index % columns + 1,
            borderTopWidth: index < columns ? 1 : 0,
            borderLeftWidth: index % columns === 0 ? 1 : 0,
          }}
          key={key}
          ref={(element) => {
            if (!room) return;
            if (element) elements.current.set(room.id, element);
            else elements.current.delete(room.id);
          }}
          className={`${styles.cell} ${!room ? styles.emptyCell : ""} ${sourceId === room?.id ? styles.dragging : ""} ${targetId === index ? styles.target : ""}`}
          draggable={!!room}
          tabIndex={0}
          role="group"
          aria-label={
            room
              ? `拖动调整 ${room.displayName} 的位置，也可使用方向键换位`
              : `空位 ${index + 1}，可拖入视频`
          }
          onDragStart={(event) => {
            if (room) startDrag(event, room);
          }}
          onDragEnd={resetDrag}
          onKeyDown={(event) => {
            if (!room || event.target !== event.currentTarget) return;
            const offsets: Record<string, number> = {
              ArrowLeft: -1,
              ArrowRight: 1,
              ArrowUp: -columns,
              ArrowDown: columns,
            };
            const offset = offsets[event.key];
            if (offset === undefined) return;
            event.preventDefault();
            const target = index + offset;
            if (target >= 0 && target < slots.length) swap(room.id, target);
          }}
          onDragOver={(event) => {
            if (!sourceId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setTargetId(sourceId === room?.id ? null : index);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setTargetId((current) => (current === index ? null : current));
            }
          }}
          onDrop={(event) => {
            if (!sourceId) return;
            event.preventDefault();
            if (sourceId !== room?.id) swap(sourceId, index);
            resetDrag();
          }}
        >
          {room ? (
            <WallLiveCard
              room={room}
              onFullscreen={onFullscreen}
              onRemove={onRemove}
            />
          ) : (
            <div className={styles.placeholder}>
              <VideoCameraAddOutlined className={styles.emptyIcon} />
            </div>
          )}
          {targetId === index && (
            <div className={styles.dropHint}>
              <SwapOutlined />{" "}
              {room
                ? `松开与「${room.displayName}」交换位置`
                : "松开放置到此空位"}
            </div>
          )}
        </div>
      ))}
      <span className={styles.srOnly} role="status">
        {sourceId ? "正在拖动直播卡片，请拖到目标卡片后松开；按 Esc 取消" : ""}
      </span>
    </div>
  );
}
