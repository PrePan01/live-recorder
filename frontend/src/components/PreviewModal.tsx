import { styles } from "./preview/previewStyles";
import { playbackClock } from "../utils/playbackClock";
import {
  CloseOutlined,
  CommentOutlined,
  CompressOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { Button, Modal, Popconfirm, Popover, Space, Tooltip } from "antd";
import { useCallback, useId, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { disableHighlightBuffer } from "../api/rooms";
import { danmakuStateText } from "../stores/danmakuStore";
import type { Room } from "../types/room";
import { DanmakuLayer } from "./DanmakuLayer";
import DanmakuSettings from "./DanmakuSettings";
import RecordingStopIcon from "./RecordingStopIcon";
import VideoPlayer from "./VideoPlayer";

import { HighlightActions } from "./preview/HighlightActions";
import { PreviewRecordingTrack } from "./preview/PreviewRecordingTrack";
import { usePreviewDanmaku } from "./preview/usePreviewDanmaku";
import { usePreviewHighlights } from "./preview/usePreviewHighlights";
import { usePreviewLayout } from "./preview/usePreviewLayout";
import { usePreviewMarkers } from "./preview/usePreviewMarkers";
import { usePreviewRecording } from "./preview/usePreviewRecording";
import { usePreviewSeek } from "./preview/usePreviewSeek";
/**
 * 直播观看弹窗
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
  enableHighlights?: boolean;
}) {
  const playerPortalId = useId();
  const [previewVideo, setPreviewVideo] = useState<HTMLVideoElement | null>(
    null,
  );
  const [markerNavigationContainer, setMarkerNavigationContainer] =
    useState<HTMLSpanElement | null>(null);
  const {
    now,
    live,
    recording,
    onAir,
    busy,
    actingAction,
    activeRecordingId,
    activeRecordingRef,
    displayedTrack,
    trackClosing,
    trackElapsedSeconds,
    recentStop,
    handleStart,
    handleStop,
  } = usePreviewRecording(room);
  const {
    pictureInPicture,
    setPictureInPicture,
    picturePosition,
    previewPlayerBounds,
    previewPlayerVisible,
    setPreviewPlayerSlot,
    streamRatio,
    streamRatioReady,
    handleStreamAspectRatio,
    modalWidth,
    modalHeight,
    videoBox,
    trackWidth,
    pictureBox,
    portrait,
    trackRevealRef,
    setTrackCollapsed,
    enterPictureInPicture,
    onPictureMouseDown,
    onPictureClick,
    onHandleDown,
  } = usePreviewLayout(defaultWidth, displayedTrack);
  const highlights = usePreviewHighlights(
    room,
    recording,
    onAir,
    enableHighlights,
  );
  const { highlightEnabled } = highlights;
  const {
    seekPlayback,
    seekActualStart,
    seekIndexState,
    displayPreview,
    setDisplayPreview,
    previewFrameGenerationRef,
    requestedPlaybackRef,
    lastSeekCommitRef,
    handleSeekIntent,
    handleSeekCommit,
    handleSeekTail,
    handleSeekError,
    handleSeekRetry,
    handleSeekFirstFrame,
  } = usePreviewSeek(
    room.id,
    activeRecordingId,
    trackElapsedSeconds,
    previewVideo,
  );
  const {
    danmakuVisible,
    danmakuOpacity,
    danmakuDensity,
    setDanmakuVisible,
    setDanmakuOpacity,
    setDanmakuDensity,
    liveDanmaku,
    danmakuMessages,
    danmakuGaps,
    trackGaps,
    streamHealth,
    displayedDanmakuStatus,
    getDanmakuTimeMs,
  } = usePreviewDanmaku(
    room.id,
    activeRecordingId,
    seekPlayback,
    previewVideo,
    previewFrameGenerationRef,
  );
  const {
    markers,
    addingMarker,
    updateMarkers,
    handleClipExport,
    quickAddMarker,
  } = usePreviewMarkers(
    room,
    live,
    activeRecordingId,
    activeRecordingRef,
    displayPreview,
    trackClosing,
  );
  const resetLiveDanmakuTime = liveDanmaku.resetTime;
  const handleLiveFirstFrame = useCallback(() => {
    if (requestedPlaybackRef.current) return;
    const lastCommit = lastSeekCommitRef.current;
    if (typeof lastCommit?.target === "number") return;
    lastSeekCommitRef.current = null;
    resetLiveDanmakuTime();
    setDisplayPreview({ mode: "live" });
    try {
      performance.measure("lr-seek:to-live-first-frame", "lr-seek:to-live");
    } catch {
      /* 无切直播打点时静默 */
    }
  }, [
    requestedPlaybackRef,
    lastSeekCommitRef,
    resetLiveDanmakuTime,
    setDisplayPreview,
  ]);

  const handleClose = () => {
    if (enableHighlights)
      void disableHighlightBuffer(room.id).catch(() => undefined);
    onClose();
  };

  const formatRecordingElapsed = (startedAt: string | undefined) => {
    const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const seconds = Number.isNaN(startedAtMs)
      ? 0
      : Math.max(0, Math.floor((now - startedAtMs) / 1_000));
    return playbackClock(seconds);
  };
  return (
    <>
      <Modal
        open={!pictureInPicture}
        aria-owns={playerPortalId}
        title={
          <div style={styles.header}>
            <span className="lr-preview-modal__name">{`${titlePrefix}：${room.displayName}`}</span>
            <Space size={4}>
              <Popover
                trigger="click"
                placement="bottomRight"
                content={
                  <DanmakuSettings
                    compact
                    visible={danmakuVisible}
                    opacity={danmakuOpacity}
                    density={danmakuDensity}
                    statusText={
                      displayedDanmakuStatus &&
                      (recording ||
                        displayedDanmakuStatus.state !== "collecting")
                        ? danmakuStateText(displayedDanmakuStatus.state)
                        : undefined
                    }
                    onVisibleChange={setDanmakuVisible}
                    onOpacityChange={setDanmakuOpacity}
                    onDensityChange={setDanmakuDensity}
                  />
                }
              >
                <Tooltip title="弹幕设置">
                  <Button
                    type="text"
                    size="small"
                    aria-label="弹幕设置"
                    icon={<CommentOutlined />}
                  />
                </Tooltip>
              </Popover>
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
        width={modalWidth}
        style={
          { "--lr-preview-modal-height": `${modalHeight}px` } as CSSProperties
        }
        className="lr-preview-modal"
        centered
        destroyOnHidden
        closable={false}
        onCancel={handleClose}
      >
        <div style={styles.body}>
          <div style={styles.content}>
            <div
              style={{
                position: "relative",
                margin: "0 auto",
                width: videoBox.width,
                height: videoBox.height,
                flexShrink: 1,
                minHeight: 0,
              }}
            >
              <div ref={setPreviewPlayerSlot} style={styles.playerSlot} />
            </div>
            <PreviewRecordingTrack
              displayedTrack={displayedTrack}
              trackClosing={trackClosing}
              trackRevealRef={trackRevealRef}
              trackWidth={trackWidth}
              trackGaps={trackGaps}
              trackElapsedSeconds={trackElapsedSeconds}
              markers={markers}
              quickAddMarker={quickAddMarker}
              setMarkerNavigationContainer={setMarkerNavigationContainer}
              addingMarker={addingMarker}
              displayPreview={displayPreview}
              recording={recording}
              streamHealth={streamHealth}
              handleSeekIntent={handleSeekIntent}
              handleSeekCommit={handleSeekCommit}
              seekPlayback={seekPlayback}
              seekIndexState={seekIndexState}
              seekActualStart={seekActualStart}
              updateMarkers={updateMarkers}
              handleClipExport={handleClipExport}
              setTrackCollapsed={setTrackCollapsed}
              markerNavigationContainer={markerNavigationContainer}
            />
          </div>
          <div style={styles.footer}>
            {recording ? (
              <Popconfirm title="确定停止当前录制？" onConfirm={handleStop}>
                <Button
                  size="small"
                  danger
                  className="lr-record-stop-button"
                  icon={<RecordingStopIcon />}
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
                    style={styles.actionButton}
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
                  <HighlightActions {...highlights} />
                ) : null}
              </Space>
            )}
          </div>
        </div>
      </Modal>
      {createPortal(
        <div
          id={playerPortalId}
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
              ? pictureBox.width
              : (previewPlayerBounds?.width ?? 0),
            height: pictureInPicture
              ? pictureBox.height
              : (previewPlayerBounds?.height ?? 0),
            zIndex: pictureInPicture ? 1100 : 1001,
            cursor: pictureInPicture ? "move" : undefined,
            borderRadius: 8,
            overflow: "hidden",
            background: "#000",
            boxShadow: pictureInPicture
              ? "0 10px 28px rgba(0,0,0,.35)"
              : undefined,
            visibility:
              !pictureInPicture && (!previewPlayerBounds || !streamRatioReady)
                ? "hidden"
                : undefined,
            opacity:
              pictureInPicture || (previewPlayerVisible && streamRatioReady)
                ? 1
                : 0,
            transition: pictureInPicture ? undefined : "opacity 180ms ease-out",
          }}
        >
          <VideoPlayer
            fill
            preserveFrameOnSwitch
            roomId={room.id}
            platform={room.platform}
            aspectRatio={streamRatio ?? undefined}
            onStreamAspectRatio={handleStreamAspectRatio}
            onVideoElementChange={setPreviewVideo}
            seek={seekPlayback}
            onSeekTail={handleSeekTail}
            onSeekFirstFrame={handleSeekFirstFrame}
            onSeekError={handleSeekError}
            onSeekRetry={handleSeekRetry}
            onLiveFirstFrame={handleLiveFirstFrame}
          />
          {danmakuVisible ? (
            <div className="lr-preview-danmaku-overlay">
              <DanmakuLayer
                messages={seekPlayback ? danmakuMessages : liveDanmaku.messages}
                gaps={seekPlayback ? danmakuGaps : []}
                getTimeMs={
                  seekPlayback ? getDanmakuTimeMs : liveDanmaku.getTimeMs
                }
                maxBullets={danmakuDensity}
                opacity={danmakuOpacity}
                resetKey={
                  seekPlayback?.generation ?? `live:${liveDanmaku.resetKey}`
                }
              />
            </div>
          ) : null}
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
                cursor: portrait ? "ns-resize" : "nwse-resize",
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
