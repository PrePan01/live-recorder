import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Button, Popconfirm, Space, Spin, Typography } from "antd";
import {
  FullscreenOutlined,
  ReloadOutlined,
  SoundOutlined,
  MutedOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { PlatformLogoTag } from "../../../../components/PlatformLogo";
import LiveStatusTag from "../../../../components/LiveStatusTag";
import type { Room } from "../../../../types/room";
import styles from "./index.module.css";
import VideoMirror from "./VideoMirror";

const VideoPlayer = lazy(() => import("../../../../components/VideoPlayer"));

export interface WallLiveCardProps {
  room: Room;
  /** 竖屏布局：卡片撑满格子，画面按真实比例自适应而非套 16:9。 */
  fill?: boolean;
  /** 所在槽位：同一个直播间可以占多格，移除时要用槽位区分。 */
  slot: number;
  isMirror?: boolean;
  mirrorSource?: HTMLVideoElement | null;
  wallFullscreen?: boolean;
  onVideoElementChange?: (element: HTMLVideoElement | null) => void;
  onFullscreen: (room: Room) => void;
  onRemove: (room: Room, slot: number) => void;
}

export default function Index({
  room,
  fill = false,
  slot,
  isMirror = false,
  mirrorSource,
  wallFullscreen = false,
  onVideoElementChange,
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
      className={`${styles.card} ${fill ? styles.cardFill : ""}`}
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
        <PlatformLogoTag platform={room.platform} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0 5px",
            maxWidth: "8rem",
          }}
        >
          {room.displayName}
        </span>
        <LiveStatusTag status={room.lastLiveStatus} />
        <Space size={0}>
          {room.lastLiveStatus === "live" ? (
            <>
              {!isMirror && (
                <Button
                  className={styles.textButton}
                  type="text"
                  size="small"
                  aria-label={muted ? "取消静音" : "静音"}
                  icon={muted ? <MutedOutlined /> : <SoundOutlined />}
                  onClick={() => setMuted((value) => !value)}
                />
              )}
              <Button
                className={`${styles.textButton} ${styles.fullscreenButton}`}
                type="text"
                size="small"
                aria-label="全屏"
                icon={<FullscreenOutlined />}
                onClick={() => onFullscreen(room)}
              />
            </>
          ) : null}
          <Button
            className={styles.textButton}
            type="text"
            size="small"
            aria-label="重新加载"
            icon={<ReloadOutlined />}
            onClick={() => setReloadTick((value) => value + 1)}
          />
          <Popconfirm
            title="移除该路？录制不受影响"
            onConfirm={() => onRemove(room, slot)}
          >
            <Button
              className={styles.textButton}
              type="text"
              size="small"
              aria-label="移除"
              icon={<CloseOutlined />}
            />
          </Popconfirm>
        </Space>
      </div>
      {room.lastLiveStatus === "live" ? (
        <Suspense
          fallback={<Spin style={{ display: "block", margin: "40px auto" }} />}
        >
          {isMirror ? (
            <VideoMirror
              source={mirrorSource ?? null}
              layoutVersion={wallFullscreen}
            />
          ) : (
            <VideoPlayer
              key={`${room.id}-${reloadTick}`}
              roomId={room.id}
              platform={room.platform}
              muted={isMirror ? true : muted}
              fill={fill}
              onVideoElementChange={onVideoElementChange}
            />
          )}
        </Suspense>
      ) : (
        <div
          style={{
            display: "grid",
            placeItems: "center",
            ...(fill ? { height: "100%" } : { aspectRatio: "16 / 9" }),
            background: "var(--lr-bg-secondary, rgba(0,0,0,0.04))",
          }}
        >
          <Typography.Text type="secondary">未开播</Typography.Text>
        </div>
      )}
    </div>
  );
}
