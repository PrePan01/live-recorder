import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  App,
  Button,
  Dropdown,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Tooltip,
  Typography,
} from "antd";
import {
  ClearOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  CompressOutlined,
  StopOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import type { Room } from "../types/room";
import { useRoomStore } from "../stores/roomStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useDisplayClock } from "../hooks/useDisplayClock";
import { describeError } from "../utils/errorMap";
import { ApiError } from "../types/error";
import VideoPlayer from "./VideoPlayer";
import {
  clearHighlightBuffer,
  disableHighlightBuffer,
  enableHighlightBuffer,
  exportHighlight,
  fetchHighlightBufferStatus,
} from "../api/rooms";

const MIN_WIDTH = 560;
const MAX_WIDTH = 1200;
const PICTURE_IN_PICTURE_WIDTH = 360;
const PICTURE_IN_PICTURE_HEIGHT = 203;
type PlayerBounds = { left: number; top: number; width: number };

/**
 * 直播观看弹窗（#194）：视频画面右下角拖拽调整大小 + 画面下方录制/停止按钮。
 * 监控总览与直播墙共用；录制状态与监控卡片联动（同 roomStore）。
 */
export default function PreviewModal({
  room,
  onClose,
  titlePrefix = "观看",
  defaultWidth,
  enableHighlights = true,
}: {
  room: Room;
  onClose: () => void;
  titlePrefix?: string;
  defaultWidth?: number;
  /** 直播墙全屏复用本组件，但必须保持纯预览，不启用回溯缓存。 */
  enableHighlights?: boolean;
}) {
  const { message } = App.useApp();
  const {
    rooms,
    actingRoomId,
    actingAction,
    startRoomRecording,
    stopRoomRecording,
  } = useRoomStore();
  const highlightEnabled = useSettingsStore(
    (s) => s.settings?.highlightEnabled ?? true,
  );
  // 普通观看默认占视口约 70%，同时为窄屏和超宽屏设置合理边界；直播墙全屏可传入显式宽度。
  const [width, setWidth] = useState(
    () =>
      defaultWidth ??
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7)),
      ),
  );
  const [recentStop, setRecentStop] = useState(false);
  const [highlightSeconds, setHighlightSeconds] = useState(30);
  const [highlightMaxSeconds, setHighlightMaxSeconds] = useState(300);
  const [highlightAvailableSeconds, setHighlightAvailableSeconds] = useState(0);
  const [highlightDisabledReason, setHighlightDisabledReason] = useState<
    string | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [picturePosition, setPicturePosition] = useState({ x: 0, y: 0 });
  const [previewPlayerBounds, setPreviewPlayerBounds] =
    useState<PlayerBounds | null>(null);
  const [previewPlayerVisible, setPreviewPlayerVisible] = useState(false);
  const [previewPlayerSlot, setPreviewPlayerSlot] =
    useState<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const pictureDragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressPictureClickRef = useRef(false);
  const pictureWasPlayingRef = useRef(false);
  const pictureVideoRef = useRef<HTMLVideoElement | null>(null);

  const live = rooms.find((r) => r.id === room.id) ?? room;
  const recording =
    live.monitorState === "recording" || live.monitorState === "reconnecting";
  const now = useDisplayClock(recording);
  const onAir = live.lastLiveStatus === "live";
  const busy = actingRoomId === room.id;

  useEffect(() => {
    if (!recentStop) return;
    const t = setTimeout(() => setRecentStop(false), 1200);
    return () => clearTimeout(t);
  }, [recentStop]);

  // 此组件只用于监控页/全屏普通观看；直播墙直接使用 VideoPlayer，因此不会触发缓存。
  useEffect(() => {
    if (!enableHighlights || !highlightEnabled || recording || !onAir) {
      setHighlightAvailableSeconds(0);
      setHighlightDisabledReason(null);
      return;
    }
    let alive = true;
    const refresh = () =>
      void fetchHighlightBufferStatus(room.id)
        .then((status) => {
          if (!alive) return;
          setHighlightMaxSeconds(status.maxSeconds);
          setHighlightAvailableSeconds(status.availableSeconds);
          setHighlightDisabledReason(
            status.accepting ? null : (status.disabledReason ?? null),
          );
        })
        .catch(() => alive && setHighlightAvailableSeconds(0));
    void enableHighlightBuffer(room.id)
      .then(refresh)
      .catch(() => alive && setHighlightAvailableSeconds(0));
    const timer = window.setInterval(refresh, 1_000);
    // React Strict Mode 在开发环境会额外执行一次 effect 清理；若这里异步删除缓存，
    // DELETE 可能晚于下一次 enable 到达，造成缓存被误删并永久显示 0 秒。
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [room.id, recording, onAir, enableHighlights, highlightEnabled]);

  // 播放器始终挂在 body。普通预览时用这个占位元素的实际坐标定位，避免
  // 在画中画与弹窗之间切换时卸载 video / 重建 mpegts 连接。
  useLayoutEffect(() => {
    if (pictureInPicture || !previewPlayerSlot) {
      setPreviewPlayerVisible(false);
      return;
    }
    const slot = previewPlayerSlot;
    const syncBounds = () => {
      const { left, top, width: nextWidth } = slot.getBoundingClientRect();
      setPreviewPlayerBounds((current) =>
        current &&
        current.left === left &&
        current.top === top &&
        current.width === nextWidth
          ? current
          : { left, top, width: nextWidth },
      );
    };
    setPreviewPlayerVisible(false);
    syncBounds();
    const animationStartedAt = performance.now();
    let previousBounds: PlayerBounds | null = null;
    let stableFrames = 0;
    let frame = window.requestAnimationFrame(() => {
      setPreviewPlayerVisible(true);
      // Ant Design 的弹窗进场会改变 transform。逐帧跟随占位区域，避免
      // 顶层播放器抢先出现在最终位置而与弹窗动画脱节。
      const followModalAnimation = () => {
        const { left, top, width: nextWidth } = slot.getBoundingClientRect();
        const nextBounds = { left, top, width: nextWidth };
        const changed =
          !previousBounds ||
          previousBounds.left !== left ||
          previousBounds.top !== top ||
          previousBounds.width !== nextWidth;
        previousBounds = nextBounds;
        stableFrames = changed ? 0 : stableFrames + 1;
        setPreviewPlayerBounds((current) =>
          current &&
          current.left === left &&
          current.top === top &&
          current.width === nextWidth
            ? current
            : nextBounds,
        );
        // 至少覆盖完整的默认动效，再等待连续数帧不再变化；这也能兼容
        // WebView 首帧较慢时动效延后开始的情况。
        if (performance.now() - animationStartedAt < 500 || stableFrames < 3)
          frame = window.requestAnimationFrame(followModalAnimation);
      };
      followModalAnimation();
    });
    const observer = new ResizeObserver(syncBounds);
    observer.observe(slot);
    window.addEventListener("resize", syncBounds);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [pictureInPicture, previewPlayerSlot, width]);

  const saveHighlight = (seconds: number) => {
    seconds = Math.max(1, Math.min(Math.floor(seconds), highlightMaxSeconds));
    setExporting(true);
    void exportHighlight(room.id, seconds)
      .then(() => message.success(`${formatSeconds(seconds)}精彩时刻录制完成`))
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "精彩时刻录制失败",
        ),
      )
      .finally(() => setExporting(false));
  };

  const clearHighlight = () => {
    void clearHighlightBuffer(room.id)
      .then(() => {
        setHighlightAvailableSeconds(0);
        setHighlightDisabledReason(null);
      })
      .catch(() => message.error("清空精彩时刻缓存失败"));
  };

  const formatSeconds = (seconds: number) =>
    seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60 ? `${seconds % 60} 秒` : ""}`
      : `${seconds} 秒`;
  const formatRecordingElapsed = (startedAt: string | undefined) => {
    const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const seconds = Number.isNaN(startedAtMs)
      ? 0
      : Math.max(0, Math.floor((now - startedAtMs) / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainingSeconds = seconds % 60;
    const clock = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
  };
  const quickSeconds = [30, 60, 120, 300].map((seconds) =>
    Math.min(seconds, highlightMaxSeconds),
  );

  const handleStart = () => {
    void startRoomRecording(room.id).catch((e) =>
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "录制请求失败",
      ),
    );
  };

  const handleStop = () => {
    setRecentStop(true);
    void stopRoomRecording(room.id).catch(() => message.error("停止请求失败"));
  };

  const handleClose = () => {
    if (enableHighlights)
      void disableHighlightBuffer(room.id).catch(() => undefined);
    onClose();
  };

  const enterPictureInPicture = () => {
    setPreviewPlayerVisible(false);
    setPicturePosition({
      x: Math.max(10, window.innerWidth - PICTURE_IN_PICTURE_WIDTH - 10),
      y: Math.max(10, window.innerHeight - PICTURE_IN_PICTURE_HEIGHT - 10),
    });
    setPictureInPicture(true);
  };

  const resumePictureVideo = () => {
    if (!pictureWasPlayingRef.current) return;
    const video = pictureVideoRef.current;
    // mouseup 后 WebView 可能还会补发一次原生暂停；当前用户手势内先续播，
    // 下一帧再确认一次，避免拖拽结束后停在暂停状态。
    void video?.play().catch(() => undefined);
    window.requestAnimationFrame(
      () => void video?.play().catch(() => undefined),
    );
  };

  const onPictureMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    pictureVideoRef.current = e.currentTarget.querySelector("video");
    pictureWasPlayingRef.current = !(pictureVideoRef.current?.paused ?? true);
    pictureDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: picturePosition.x,
      originY: picturePosition.y,
      moved: false,
    };
    const onMove = (ev: MouseEvent) => {
      const drag = pictureDragRef.current;
      if (!drag) return;
      const deltaX = ev.clientX - drag.startX;
      const deltaY = ev.clientY - drag.startY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true;
      setPicturePosition({
        x: Math.max(
          0,
          Math.min(
            window.innerWidth - PICTURE_IN_PICTURE_WIDTH,
            drag.originX + deltaX,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            window.innerHeight - PICTURE_IN_PICTURE_HEIGHT,
            drag.originY + deltaY,
          ),
        ),
      });
    };
    const onUp = () => {
      const moved = pictureDragRef.current?.moved;
      pictureDragRef.current = null;
      suppressPictureClickRef.current = Boolean(moved);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) resumePictureVideo();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onPictureClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 阻止原生 video 接收这次点击并切换播放状态；画中画点击仅用于返回弹窗。
    e.preventDefault();
    e.stopPropagation();
    if (!suppressPictureClickRef.current) {
      setPictureInPicture(false);
      // 部分 WebView 会在 React click 处理结束后才执行原生 video controls
      // 的暂停逻辑，因此放到下一帧恢复，且仅恢复点击前本来就在播放的视频。
      resumePictureVideo();
    }
    suppressPictureClickRef.current = false;
  };

  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setWidth(
        Math.min(
          MAX_WIDTH,
          Math.max(
            MIN_WIDTH,
            dragRef.current.startW + (ev.clientX - dragRef.current.startX),
          ),
        ),
      );
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <Modal
        open={!pictureInPicture}
        title={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingRight: 8,
            }}
          >
            <span>{`${titlePrefix}：${room.displayName}`}</span>
            <Space size={4}>
              <Tooltip title="画中画">
                <Button
                  type="text"
                  size="small"
                  aria-label="画中画"
                  icon={<CompressOutlined />}
                  onClick={enterPictureInPicture}
                />
              </Tooltip>
              <Tooltip title="关闭">
                <Button
                  type="text"
                  size="small"
                  aria-label="关闭预览"
                  icon={<CloseOutlined />}
                  onClick={handleClose}
                />
              </Tooltip>
            </Space>
          </div>
        }
        footer={null}
        width={width}
        centered
        destroyOnHidden
        closable={false}
        onCancel={handleClose}
      >
        <div>
          <div
            ref={setPreviewPlayerSlot}
            style={{
              position: "relative",
              background: "#000",
              overflow: "hidden",
              aspectRatio: "16 / 9",
            }}
          />
          <div style={{ marginTop: 12, textAlign: "center" }}>
            {recording ? (
              <Popconfirm title="确定停止当前录制？" onConfirm={handleStop}>
                <Button
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  loading={busy && actingAction === "stop"}
                >
                  停止录制（
                  {formatRecordingElapsed(live.activeRecording?.startedAt)}）
                </Button>
              </Popconfirm>
            ) : (
              <Space>
                <Tooltip title={!onAir ? "未开播，无法录制" : undefined}>
                  <Button
                    style={{ width: 100 }}
                    size="small"
                    type="primary"
                    icon={<VideoCameraAddOutlined />}
                    disabled={!onAir || recentStop}
                    loading={busy && actingAction === "record"}
                    onClick={handleStart}
                  >
                    录制
                  </Button>
                </Tooltip>
                {enableHighlights && highlightEnabled ? (
                  <Dropdown
                    trigger={["click"]}
                    placement="top"
                    dropdownRender={() => (
                      <div
                        style={{
                          width: 310,
                          padding: 14,
                          borderRadius: 10,
                          background: "#fff",
                          boxShadow: "0 10px 28px rgba(0,0,0,.16)",
                        }}
                      >
                        <Space size={2} align="center">
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12 }}
                          >
                            当前已缓存
                          </Typography.Text>
                          <Tooltip title="清空当前直播缓存">
                            <Button
                              size="small"
                              type="text"
                              aria-label="清空当前直播缓存"
                              icon={<ClearOutlined />}
                              style={{ paddingInline: 3, height: 20 }}
                              disabled={highlightAvailableSeconds < 1}
                              onClick={clearHighlight}
                            />
                          </Tooltip>
                        </Space>
                        <div
                          style={{
                            fontSize: 24,
                            lineHeight: 1.25,
                            fontWeight: 650,
                            color: "#0958d9",
                            marginTop: 2,
                          }}
                        >
                          {formatSeconds(highlightAvailableSeconds)}
                        </div>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {highlightAvailableSeconds > 0
                            ? `缓存上限 ${formatSeconds(highlightMaxSeconds)}`
                            : "正在接收直播帧，稍后即可保存"}
                          {highlightDisabledReason === "slow_disk"
                            ? "；磁盘写入过慢，已暂停继续缓存（已完成片段仍可导出）"
                            : highlightDisabledReason === "write_error"
                              ? "；缓存写入失败，已暂停继续缓存（已完成片段仍可导出）"
                              : ""}
                        </Typography.Text>
                        <div
                          style={{
                            height: 1,
                            background: "#f0f0f0",
                            margin: "12px 0",
                          }}
                        />
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          保存最近片段
                        </Typography.Text>
                        <Button.Group
                          size="small"
                          style={{
                            display: "flex",
                            marginTop: 8,
                            marginBottom: 12,
                          }}
                        >
                          {quickSeconds.map((seconds, index) => (
                            <Button
                              key={`${seconds}-${index}`}
                              style={{ flex: 1 }}
                              onClick={() => saveHighlight(seconds)}
                              disabled={
                                exporting || highlightAvailableSeconds < seconds
                              }
                            >
                              前 {formatSeconds(seconds)}
                            </Button>
                          ))}
                        </Button.Group>
                        <Space style={{ display: "flex" }}>
                          <Tooltip title="当前已缓存时长">
                            <Button
                              size="small"
                              type="text"
                              aria-label="填入当前已缓存时长"
                              icon={<ClockCircleOutlined />}
                              style={{ paddingInline: 5 }}
                              disabled={highlightAvailableSeconds < 1}
                              onClick={() =>
                                setHighlightSeconds(
                                  Math.min(
                                    highlightAvailableSeconds,
                                    highlightMaxSeconds,
                                  ),
                                )
                              }
                            />
                          </Tooltip>
                          <InputNumber
                            size="small"
                            min={1}
                            max={highlightMaxSeconds}
                            precision={0}
                            value={Math.min(
                              highlightSeconds,
                              highlightMaxSeconds,
                            )}
                            changeOnWheel
                            onChange={(v) =>
                              setHighlightSeconds(
                                Math.max(1, Math.round(Number(v ?? 30))),
                              )
                            }
                            style={{ flex: 1 }}
                            addonAfter="秒"
                          />
                          <Button
                            size="small"
                            type="primary"
                            loading={exporting}
                            disabled={
                              highlightAvailableSeconds < 1 ||
                              highlightSeconds > highlightAvailableSeconds
                            }
                            onClick={() => saveHighlight(highlightSeconds)}
                          >
                            保存
                          </Button>
                        </Space>
                      </div>
                    )}
                  >
                    <Button
                      style={{ width: 100 }}
                      size="small"
                      icon={<ClockCircleOutlined />}
                      disabled={exporting}
                    >
                      精彩时刻
                    </Button>
                  </Dropdown>
                ) : null}
              </Space>
            )}
          </div>
        </div>
      </Modal>
      {createPortal(
        <div
          role={pictureInPicture ? "button" : undefined}
          tabIndex={pictureInPicture ? 0 : undefined}
          aria-label={pictureInPicture ? "画中画视频，点击返回预览" : undefined}
          title={pictureInPicture ? "拖动移动；点击返回预览" : undefined}
          onMouseDown={pictureInPicture ? onPictureMouseDown : undefined}
          onClick={pictureInPicture ? onPictureClick : undefined}
          onKeyDown={(e) => {
            if (pictureInPicture && (e.key === "Enter" || e.key === " "))
              setPictureInPicture(false);
          }}
          style={{
            position: "fixed",
            left: pictureInPicture
              ? picturePosition.x
              : (previewPlayerBounds?.left ?? 0),
            top: pictureInPicture
              ? picturePosition.y
              : (previewPlayerBounds?.top ?? 0),
            width: pictureInPicture
              ? PICTURE_IN_PICTURE_WIDTH
              : (previewPlayerBounds?.width ?? 0),
            zIndex: pictureInPicture ? 1100 : 1001,
            cursor: pictureInPicture ? "move" : undefined,
            borderRadius: 8,
            overflow: "hidden",
            background: "#000",
            boxShadow: pictureInPicture
              ? "0 10px 28px rgba(0,0,0,.35)"
              : undefined,
            visibility:
              !pictureInPicture && !previewPlayerBounds ? "hidden" : undefined,
            opacity: pictureInPicture || previewPlayerVisible ? 1 : 0,
            transition: pictureInPicture ? undefined : "opacity 180ms ease-out",
          }}
        >
          <VideoPlayer roomId={room.id} platform={room.platform} />
          {!pictureInPicture && (
            <div
              onMouseDown={onHandleDown}
              title="拖动调整大小"
              style={{
                position: "absolute",
                right: 4,
                bottom: 4,
                width: 18,
                height: 18,
                cursor: "nwse-resize",
                zIndex: 2,
                borderRight: "3px solid rgba(255,255,255,0.75)",
                borderBottom: "3px solid rgba(255,255,255,0.75)",
                borderBottomRightRadius: 4,
                background: "rgba(0,0,0,0.25)",
              }}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
