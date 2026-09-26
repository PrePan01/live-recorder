import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { SwapOutlined, VideoCameraAddOutlined } from "@ant-design/icons";
import type { Room } from "../../../../types/room";
import {
  getWallCapacity,
  getWallLayout,
  useWallStore,
  type WallGrid as GridLayout,
} from "../../../../stores/wallStore";
import WallLiveCard from "../WallLiveCard";
import styles from "./index.module.css";
import { stableSlotEntries } from "./slots";

interface WallGridProps {
  rooms: Room[];
  grid: GridLayout;
  wallFullscreen?: boolean;
  onFullscreen: (room: Room) => void;
  onRemove: (room: Room, slot: number) => void;
  onEmptySlotClick: (slot: number) => void;
}

export default function WallGrid({
  rooms,
  grid,
  wallFullscreen = false,
  onFullscreen,
  onRemove,
  onEmptySlotClick,
}: WallGridProps) {
  const swapSlots = useWallStore((s) => s.swapSlots);
  const roomIds = useWallStore((s) => s.roomIds);
  // 拖拽源/目标都用槽位下标：3x1 下同一个直播间能占多格，房间 id 无法区分是哪一格。
  const [sourceSlot, setSourceSlot] = useState<number | null>(null);
  const [targetSlot, setTargetSlot] = useState<number | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const positions = useRef(new Map<string, DOMRect>());
  const layout = getWallLayout(grid);
  const columns = layout.columns;
  const occupiedLength = roomIds.reduce(
    (length, id, index) => (id ? index + 1 : length),
    0,
  );
  const slots = Array.from(
    { length: Math.max(getWallCapacity(grid), occupiedLength) },
    (_, index) => rooms.find((room) => room.id === roomIds[index]),
  );
  const entries = stableSlotEntries(slots);
  const keyBySlot = new Map(entries.map((entry) => [entry.index, entry.key]));
  // 同房间的后续格子始终镜像第一个格子的 video；全屏切换不重建连接，
  // 避免独立流各自追帧而产生可感知延迟。
  const [masterVideos, setMasterVideos] = useState<
    Record<string, HTMLVideoElement | null>
  >({});
  const masterVideoCallbacks = useRef(
    new Map<string, (element: HTMLVideoElement | null) => void>(),
  );
  const masterSlotByRoomId = new Map<string, number>();
  entries.forEach(({ room, index }) => {
    if (room && !masterSlotByRoomId.has(room.id)) {
      masterSlotByRoomId.set(room.id, index);
    }
  });
  const setMasterVideo = useCallback(
    (roomId: string, element: HTMLVideoElement | null) => {
      setMasterVideos((current) =>
        current[roomId] === element
          ? current
          : { ...current, [roomId]: element },
      );
    },
    [],
  );
  const getMasterVideoCallback = useCallback(
    (roomId: string) => {
      let callback = masterVideoCallbacks.current.get(roomId);
      if (!callback) {
        callback = (element) => setMasterVideo(roomId, element);
        masterVideoCallbacks.current.set(roomId, callback);
      }
      return callback;
    },
    [setMasterVideo],
  );

  useLayoutEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.current.forEach((element, key) => {
        const before = positions.current.get(key);
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

  const swap = (source: number, target: number) => {
    positions.current.clear();
    elements.current.forEach((element, key) =>
      positions.current.set(key, element.getBoundingClientRect()),
    );
    swapSlots(source, target);
  };

  const resetDrag = () => {
    setSourceSlot(null);
    setTargetSlot(null);
  };

  const startDrag = (
    event: DragEvent<HTMLDivElement>,
    room: Room,
    slot: number,
  ) => {
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
    const element = elements.current.get(keyBySlot.get(slot) ?? "");
    if (element) {
      const rect = element.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        element,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    }
    setSourceSlot(slot);
  };

  return (
    <div
      className={`lr-wall-grid ${styles.grid}`}
      style={
        {
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          // 竖屏布局只有一行，让这一行撑满页面可用高度，格子比例交给画面自己决定。
          ...(layout.fill
            ? {
                gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
                height: "100%",
              }
            : null),
          "--wall-rows": Math.ceil(slots.length / columns),
        } as CSSProperties
      }
    >
      {entries.map(({ room, index, key }) => {
        const isMaster = !!room && masterSlotByRoomId.get(room.id) === index;
        const isMirror = !!room && !isMaster;
        return (
          <div
            style={{
              gridRow: Math.floor(index / columns) + 1,
              gridColumn: (index % columns) + 1,
              borderTopWidth: index < columns ? 1 : 0,
              borderLeftWidth: index % columns === 0 ? 1 : 0,
            }}
            key={key}
            ref={(element) => {
              if (!room) return;
              if (element) elements.current.set(key, element);
              else elements.current.delete(key);
            }}
            className={`${styles.cell} ${layout.fill ? styles.fillCell : ""} ${!room ? styles.emptyCell : ""} ${sourceSlot === index ? styles.dragging : ""} ${targetSlot === index ? styles.target : ""}`}
            draggable={!!room}
            tabIndex={0}
            role="group"
            aria-label={
              room
                ? `拖动调整 ${room.displayName} 的位置，也可使用方向键换位`
                : `空位 ${index + 1}，点击添加直播间或拖入视频`
            }
            onClick={() => {
              if (!room && sourceSlot === null) onEmptySlotClick(index);
            }}
            onDragStart={(event) => {
              if (room) startDrag(event, room, index);
            }}
            onDragEnd={resetDrag}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (!room && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                onEmptySlotClick(index);
                return;
              }
              if (!room) return;
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
              if (target >= 0 && target < slots.length) swap(index, target);
            }}
            onDragOver={(event) => {
              if (sourceSlot === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTargetSlot(sourceSlot === index ? null : index);
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              ) {
                setTargetSlot((current) =>
                  current === index ? null : current,
                );
              }
            }}
            onDrop={(event) => {
              if (sourceSlot === null) return;
              event.preventDefault();
              if (sourceSlot !== index) swap(sourceSlot, index);
              resetDrag();
            }}
          >
            {room ? (
              <WallLiveCard
                room={room}
                fill={layout.fill}
                onFullscreen={onFullscreen}
                onRemove={onRemove}
                slot={index}
                isMirror={isMirror}
                mirrorSource={
                  isMirror ? (masterVideos[room.id] ?? null) : undefined
                }
                wallFullscreen={wallFullscreen}
                onVideoElementChange={
                  isMaster ? getMasterVideoCallback(room.id) : undefined
                }
              />
            ) : (
              <div
                className={`${styles.placeholder} ${layout.fill ? styles.placeholderFill : ""}`}
              >
                <VideoCameraAddOutlined className={styles.emptyIcon} />
              </div>
            )}
            {targetSlot === index && (
              <div className={styles.dropHint}>
                <SwapOutlined />{" "}
                {room
                  ? `松开与「${room.displayName}」交换位置`
                  : "松开放置到此空位"}
              </div>
            )}
          </div>
        );
      })}
      <span className={styles.srOnly} role="status">
        {sourceSlot !== null
          ? "正在拖动直播卡片，请拖到目标卡片后松开；按 Esc 取消"
          : ""}
      </span>
    </div>
  );
}
