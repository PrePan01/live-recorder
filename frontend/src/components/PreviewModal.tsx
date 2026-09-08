import { useEffect, useRef, useState } from "react";
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
  ClockCircleOutlined,
  StopOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import type { Room } from "../types/room";
import { useRoomStore } from "../stores/roomStore";
import { useSettingsStore } from "../stores/settingsStore";
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
  const [exporting, setExporting] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const live = rooms.find((r) => r.id === room.id) ?? room;
  const recording =
    live.monitorState === "recording" || live.monitorState === "reconnecting";
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
      return;
    }
    let alive = true;
    const refresh = () =>
      void fetchHighlightBufferStatus(room.id)
        .then((status) => {
          if (!alive) return;
          setHighlightMaxSeconds(status.maxSeconds);
          setHighlightAvailableSeconds(status.availableSeconds);
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

  const saveHighlight = (seconds: number) => {
    seconds = Math.max(1, Math.min(Math.floor(seconds), highlightMaxSeconds));
    setExporting(true);
    void exportHighlight(room.id, seconds)
      .then(() =>
        message.success(
          `已开始导出前 ${formatSeconds(seconds)}精彩时刻`,
        ),
      )
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "精彩时刻导出失败",
        ),
      )
      .finally(() => setExporting(false));
  };

  const clearHighlight = () => {
    void clearHighlightBuffer(room.id)
      .then(() => {
        setHighlightAvailableSeconds(0);
      })
      .catch(() => message.error("清空精彩时刻缓存失败"));
  };

  const formatSeconds = (seconds: number) =>
    seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60 ? `${seconds % 60} 秒` : ""}`
      : `${seconds} 秒`;
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
    <Modal
      open
      title={`${titlePrefix}：${room.displayName}`}
      footer={null}
      width={width}
      centered
      destroyOnHidden
      onCancel={handleClose}
    >
      <div>
        <div
          style={{
            position: "relative",
            background: "#000",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <VideoPlayer
            // preview-only → recording 会切换到全新 FLV 时间线；强制重建播放器，不能复用旧 MSE。
            key={`${room.id}:${recording ? "recording" : "preview"}`}
            roomId={room.id}
            platform={room.platform}
          />
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
        </div>
        <div style={{ marginTop: 12, textAlign: "center" }}>
          {recording ? (
            <Popconfirm title="确定停止当前录制？" onConfirm={handleStop}>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={busy && actingAction === "stop"}
              >
                停止录制
              </Button>
            </Popconfirm>
          ) : (
            <Space>
              <Tooltip title={!onAir ? "未开播，无法录制" : undefined}>
                <Button
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
                          onChange={(v) => setHighlightSeconds(Math.max(1, Math.round(Number(v ?? 30))))}
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
  );
}
