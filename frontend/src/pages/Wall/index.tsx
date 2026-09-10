import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Modal, Select, Space, Typography } from "antd";
import {
  FullscreenOutlined,
  FullscreenExitOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useRoomStore } from "../../stores/roomStore";
import { usePreviewStore } from "../../stores/previewStore";
import { getWallCapacity, useWallStore } from "../../stores/wallStore";
import PreviewModal from "../../components/PreviewModal";
import WallGrid from "../../components/WallGrid";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import type { Room } from "../../types/room";
import styles from "./index.module.css";
import { enterWallFullscreen as requestWallFullscreen } from "./fullscreen";

export default function Wall() {
  const { message } = App.useApp();
  const { rooms, fetchRooms } = useRoomStore();
  const openPreview = usePreviewStore((s) => s.open);
  const closePreview = usePreviewStore((s) => s.close);
  const wallRoomIds = useWallStore((s) => s.roomIds);
  const grid = useWallStore((s) => s.grid);
  const setGrid = useWallStore((s) => s.setGrid);
  const addRooms = useWallStore((s) => s.addRooms);
  const removeWallRoom = useWallStore((s) => s.removeRoom);
  const reconcile = useWallStore((s) => s.reconcile);
  const [addOpen, setAddOpen] = useState(false);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [fullscreen, setFullscreen] = useState<Room | null>(null);
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
    try {
      const restore = await requestWallFullscreen(videoAreaRef.current);
      if (!mounted.current) await restore();
      else {
        restoreFullscreen.current = restore;
        setWallFullscreen(true);
      }
    } catch {
      message.error("无法进入全屏，请重试");
    } finally {
      fullscreenBusy.current = false;
    }
  };

  const exitWallFullscreen = useCallback(async () => {
    if (fullscreenBusy.current || !restoreFullscreen.current) return;
    fullscreenBusy.current = true;
    try {
      await restoreFullscreen.current();
      restoreFullscreen.current = null;
      setWallFullscreen(false);
    } catch {
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
    };
  }, []);

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

  const available = useMemo(
    () => rooms.filter((r) => r.enabled && !wallRoomIds.includes(r.id)),
    [rooms, wallRoomIds],
  );

  const capacity = getWallCapacity(grid);
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

  const handleRemove = (room: Room) => {
    closePreview(room.id);
    removeWallRoom(room.id);
    setPickedIds([]);
  };

  const handleGridChange = (value: string | number) => {
    const nextGrid = value as "2x2" | "3x3";
    // Keep preview bookkeeping in sync with rooms removed when 3x3 is
    // reduced to 2x2. The grid store performs the actual slot truncation.
    if (nextGrid === "2x2") {
      wallRoomIds.slice(getWallCapacity(nextGrid)).forEach((roomId) => {
        if (roomId) closePreview(roomId);
      });
    }
    setGrid(nextGrid);
  };

  return (
    <div className="lr-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          多路直播墙
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <MemphisRadioGroup
            options={["2x2", "3x3"]}
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
          onFullscreen={setFullscreen}
          onRemove={handleRemove}
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
            }))}
            maxTagCount="responsive"
          />
        </Space>
      </Modal>
      {fullscreen ? (
        <PreviewModal
          room={fullscreen}
          titlePrefix="全屏"
          defaultWidth={880}
          enableHighlights={false}
          onClose={() => setFullscreen(null)}
        />
      ) : null}
    </div>
  );
}
