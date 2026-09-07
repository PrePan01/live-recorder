import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Button, Popconfirm, Space, Spin, Typography } from "antd";
import {
  FullscreenOutlined,
  ReloadOutlined,
  SoundOutlined,
  MutedOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { PlatformLogoTag } from "../PlatformLogo.tsx";
import LiveStatusTag from "../LiveStatusTag.tsx";
import type { Room } from "../../types/room.ts";
import styles from "./index.module.css";

const VideoPlayer = lazy(() => import("../VideoPlayer.tsx"));

export interface WallLiveCardProps {
  room: Room;
  onFullscreen: (room: Room) => void;
  onRemove: (room: Room) => void;
}

export default function Index({
  room,
  onFullscreen,
  onRemove,
}: WallLiveCardProps) {
  const [muted, setMuted] = useState(true);
  /** 单路重载计数：仅重挂该路播放器，不共享重载。 */
  const [reloadTick, setReloadTick] = useState(0);
  const [isShowTitle, setShowTitle] = useState<boolean>(false);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTitleTimer = () => {
    if (titleTimerRef.current !== null) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
  };

  const showTitle = () => {
    setShowTitle(true);
    clearTitleTimer();
    titleTimerRef.current = setTimeout(() => {
      setShowTitle(false);
      titleTimerRef.current = null;
    }, 5_000);
  };

  const hideTitle = () => {
    clearTitleTimer();
    setShowTitle(false);
  };

  useEffect(() => {
    return () => {
      if (titleTimerRef.current !== null) clearTimeout(titleTimerRef.current);
    };
  }, []);

  return (
    <div
      className={styles.card}
      onMouseEnter={showTitle}
      onMouseMove={showTitle}
      onMouseLeave={hideTitle}
    >
      <div
        className={styles.title}
        style={{
          display:
            room.lastLiveStatus !== "live" || isShowTitle ? "flex" : "none",
        }}
      >
        <PlatformLogoTag platform={room.platform} isShowName={false} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 8px",
          }}
        >
          {room.displayName}
        </span>
        <LiveStatusTag status={room.lastLiveStatus} />
        <Space size={0}>
          <Button
            className={styles.textButton}
            type="text"
            size="small"
            icon={muted ? <MutedOutlined /> : <SoundOutlined />}
            onClick={() => setMuted((value) => !value)}
          ></Button>
          <Button
            className={`${styles.textButton} ${styles.fullscreenButton}`}
            type="text"
            size="small"
            icon={<FullscreenOutlined />}
            onClick={() => onFullscreen(room)}
          />
          <Button
            className={styles.textButton}
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setReloadTick((value) => value + 1)}
          />
          <Popconfirm
            title="移除该路？录制不受影响"
            onConfirm={() => onRemove(room)}
          >
            <Button type="text" size="small" danger icon={<CloseOutlined />} />
          </Popconfirm>
        </Space>
      </div>
      {room.lastLiveStatus === "live" ? (
        <Suspense
          fallback={<Spin style={{ display: "block", margin: "40px auto" }} />}
        >
          <VideoPlayer
            key={`${room.id}-${reloadTick}`}
            roomId={room.id}
            platform={room.platform}
            muted={muted}
          />
        </Suspense>
      ) : (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            aspectRatio: "16 / 9",
            background: "var(--lr-bg-secondary, rgba(0,0,0,0.04))",
          }}
        >
          <Typography.Text type="secondary">未开播</Typography.Text>
        </div>
      )}
    </div>
  );
}
