import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { App, Button, Modal, Select, Space, Typography } from "antd";
import {
  FullscreenOutlined,
  FullscreenExitOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useRoomStore } from "../../stores/roomStore";
import { usePreviewStore } from "../../stores/previewStore";
import {
  applyGridLayout,
  getWallCapacity,
  getWallLayout,
  useWallStore,
  type WallGrid as GridLayout,
} from "../../stores/wallStore";
import WallGrid from "./components/WallGrid";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import { PlatformIcon } from "../../components/PlatformLogo";
import LiveStatusTag from "../../components/LiveStatusTag";
import type { Room } from "../../types/room";
import { recordRecentErrorAction } from "../../utils/errorDiagnostics";
import styles from "./index.module.css";
import { enterWallFullscreen as requestWallFullscreen } from "./fullscreen";

const GRID_OPTIONS = [
  { label: "2x2", value: "2x2" },
  { label: "3x3", value: "3x3" },
  {
    label: (
      <span className={styles.gridOptionLabel}>
        <span className={styles.gridOptionTitle}>3×1</span>
        <small>支持镜像</small>
      </span>
    ),
    value: "3x1",
  },
] satisfies { label: ReactNode; value: GridLayout }[];

export default function Wall() {
  const { message } = App.useApp();
  const { rooms, fetchRooms } = useRoomStore();
  const openPreview = usePreviewStore((s) => s.open);
  const openPreviewModal = usePreviewStore((s) => s.openModal);
  const closePreview = usePreviewStore((s) => s.close);
  const activeModalRoomId = usePreviewStore((s) => s.activeModal?.roomId);
  const activeModalRoomIdRef = useRef(activeModalRoomId);
  useEffect(() => {
    activeModalRoomIdRef.current = activeModalRoomId;
  }, [activeModalRoomId]);
  // 观看弹窗的画中画由应用布局持有；直播墙只释放自己独占的预览会话。
  const closeWallPreview = useCallback(
    (roomId: string) => {
      if (roomId !== activeModalRoomIdRef.current) closePreview(roomId);
    },
    [closePreview],
  );
  const wallRoomIds = useWallStore((s) => s.roomIds);
  const wallRoomIdsRef = useRef(wallRoomIds);
  useEffect(() => {
    wallRoomIdsRef.current = wallRoomIds;
  }, [wallRoomIds]);
  const grid = useWallStore((s) => s.grid);
  const setGrid = useWallStore((s) => s.setGrid);
  const addRooms = useWallStore((s) => s.addRooms);
  const addRoomToSlot = useWallStore((s) => s.addRoomToSlot);
  const removeWallSlot = useWallStore((s) => s.removeSlot);
  const reconcile = useWallStore((s) => s.reconcile);
  const [addOpen, setAddOpen] = useState(false);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [slotPicker, setSlotPicker] = useState<number | null>(null);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  const [wallFullscreen, setWallFullscreen] = useState(false);
  const restoreFullscreen = useRef<(() => Promise<void>) | null>(null);
  const fullscreenBusy = useRef(false);
  const mounted = useRef(true);

  const enterWallFullscreen = async () => {
    if (
      fullscreenBusy.current ||
      restoreFullscreen.current ||
      !videoAreaRef.current
    )
      return;
    fullscreenBusy.current = true;
    recordRecentErrorAction("wall:enter-fullscreen");
    try {
      const restore = await requestWallFullscreen(videoAreaRef.current);
      if (!mounted.current) await restore();
      else {
        restoreFullscreen.current = restore;
        setWallFullscreen(true);
        recordRecentErrorAction("wall:fullscreen-active");
      }
    } catch {
      recordRecentErrorAction("wall:enter-fullscreen-failed");
      message.error("无法进入全屏，请重试");
    } finally {
      fullscreenBusy.current = false;
    }
  };

  const exitWallFullscreen = useCallback(async () => {
    if (fullscreenBusy.current || !restoreFullscreen.current) return;
    fullscreenBusy.current = true;
    recordRecentErrorAction("wall:exit-fullscreen");
    try {
      await restoreFullscreen.current();
      restoreFullscreen.current = null;
      setWallFullscreen(false);
      recordRecentErrorAction("wall:fullscreen-exited");
    } catch {
      recordRecentErrorAction("wall:exit-fullscreen-failed");
      message.error("无法退出全屏，请重试");
    } finally {
      fullscreenBusy.current = false;
    }
  }, [message]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void restoreFullscreen.current?.().catch(() => {});
      restoreFullscreen.current = null;
      // 离开直播墙时释放本页打开的预览，避免 openRoomIds 泄漏。
      wallRoomIdsRef.current.forEach((rid) => {
        if (rid) closeWallPreview(rid);
      });
    };
  }, [closeWallPreview]);

  useEffect(() => {
    if (!wallFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void exitWallFullscreen();
      }
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) void exitWallFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [wallFullscreen, exitWallFullscreen]);

  useEffect(() => {
    void fetchRooms().catch(() => message.error("房间加载失败"));
  }, [fetchRooms, message]);

  useEffect(() => {
    reconcile(rooms);
  }, [rooms, reconcile]);

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const wallRooms = useMemo(
    () =>
      wallRoomIds
        .map((id) => (id === null ? undefined : roomById.get(id)))
        .filter((r): r is Room => r !== undefined),
    [wallRoomIds, roomById],
  );

  const layout = getWallLayout(grid);
  // 允许重复的布局（3x1）里，已经在墙上的直播间仍要出现在候选里，否则加不了第二格。
  const available = useMemo(
    () =>
      rooms.filter(
        (r) =>
          r.enabled && (layout.allowDuplicates || !wallRoomIds.includes(r.id)),
      ),
    [rooms, wallRoomIds, layout.allowDuplicates],
  );

  const renderRoomOption = (room: Room) => (
    <div className={styles.roomOption}>
      <span className={styles.roomOptionMain}>
        <PlatformIcon platform={room.platform} size={16} />
        <span className={styles.roomOptionName}>{room.displayName}</span>
      </span>
      <LiveStatusTag status={room.lastLiveStatus} />
    </div>
  );

  const capacity = getWallCapacity(grid);
  const fill = layout.fill;
  const roomCount = wallRoomIds.filter(Boolean).length;
  const remainingSlots = Math.max(0, capacity - roomCount);

  const handleAdd = () => {
    if (pickedIds.length === 0) return;
    const res = addRooms(pickedIds);
    res.added.forEach((id) => openPreview(id));
    setPickedIds([]);
    setAddOpen(false);
    message.info(`已添加 ${res.added.length} 路到直播墙`);
  };

  const handlePickSlotRoom = (roomId: string) => {
    if (slotPicker === null) return;
    if (!addRoomToSlot(roomId, slotPicker)) {
      message.warning("该网格已被占用，请重新选择");
      setSlotPicker(null);
      return;
    }
    openPreview(roomId);
    setSlotPicker(null);
  };

  const handleRemove = (room: Room, slot: number) => {
    // 该房间可能还占着别的格子（3x1），只有最后一格被移除时才释放预览会话。
    const stillOnWall = wallRoomIds.some(
      (id, index) => id === room.id && index !== slot,
    );
    removeWallSlot(slot);
    if (!stillOnWall) closeWallPreview(room.id);
    setPickedIds([]);
  };

  const handleGridChange = (value: string | number) => {
    const nextGrid = value as GridLayout;
    const kept = new Set(
      applyGridLayout(wallRoomIds, nextGrid).filter(Boolean),
    );
    wallRoomIds.forEach((roomId) => {
      if (roomId && !kept.has(roomId)) closeWallPreview(roomId);
    });
    setGrid(nextGrid);
  };

  const handleRoomFullscreen = (room: Room) => {
    if (
      !openPreviewModal({
        roomId: room.id,
        titlePrefix: "全屏",
        defaultWidth: 1080,
        enableHighlights: false,
      })
    ) {
      message.warning("预览数量已达上限，请先关闭其他预览");
    }
  };

  return (
    <div className={`lr-page ${fill ? styles.fillPage : ""}`}>
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          直播墙
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <MemphisRadioGroup
            className={styles.gridSelector}
            options={GRID_OPTIONS}
            value={grid}
            onChange={(event) => handleGridChange(event.target.value)}
          />
          <Button
            icon={<FullscreenOutlined />}
            aria-label="全屏直播墙"
            onClick={() => void enterWallFullscreen()}
            disabled={wallRooms.length === 0}
          ></Button>
          <Button
            icon={<PlusOutlined />}
            onClick={() => setAddOpen(true)}
            disabled={available.length === 0}
          >
            添加房间
          </Button>
        </Space>
      </Space>
      <div
        ref={videoAreaRef}
        className={`${styles.videoArea} ${wallFullscreen ? styles.fullscreen : ""}`}
        data-wall-fullscreen={wallFullscreen || undefined}
      >
        <WallGrid
          rooms={wallRooms}
          grid={grid}
          wallFullscreen={wallFullscreen}
          onFullscreen={handleRoomFullscreen}
          onRemove={handleRemove}
          onEmptySlotClick={setSlotPicker}
        />
        {wallFullscreen && (
          <Button
            className={styles.exitFullscreen}
            icon={<FullscreenExitOutlined />}
            onClick={() => void exitWallFullscreen()}
          ></Button>
        )}
      </div>
      <Modal
        title="添加房间到直播墙"
        open={addOpen}
        onOk={handleAdd}
        okText="添加"
        okButtonProps={{ disabled: pickedIds.length === 0 }}
        onCancel={() => {
          setPickedIds([]);
          setAddOpen(false);
        }}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {remainingSlots > 0
              ? `还可添加 ${remainingSlots} 路，上限 ${capacity} 路。默认静音。`
              : `直播墙已满（${roomCount}/${capacity}），请切换更大布局或移除房间后再添加。`}
          </Typography.Text>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            placeholder="搜索并选择直播间"
            showSearch
            optionFilterProp="label"
            value={pickedIds}
            onChange={setPickedIds}
            disabled={remainingSlots <= 0}
            maxCount={remainingSlots > 0 ? remainingSlots : undefined}
            options={available.map((r) => ({
              value: r.id,
              label: r.displayName,
              room: r,
            }))}
            optionRender={(option) =>
              renderRoomOption((option.data as { room: Room }).room)
            }
            maxTagCount="responsive"
          />
        </Space>
      </Modal>
      <Modal
        title="添加直播间"
        open={slotPicker !== null}
        footer={null}
        destroyOnHidden
        onCancel={() => setSlotPicker(null)}
      >
        <Select
          autoFocus
          style={{ width: "100%" }}
          placeholder="搜索并选择直播间"
          showSearch
          optionFilterProp="label"
          onChange={handlePickSlotRoom}
          options={available.map((room) => ({
            value: room.id,
            label: room.displayName,
            room,
          }))}
          optionRender={(option) =>
            renderRoomOption((option.data as { room: Room }).room)
          }
        />
      </Modal>
    </div>
  );
}
