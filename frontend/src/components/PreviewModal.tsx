import { useRecordingMediaRange } from "../hooks/useRecordingMediaRange";
import { useRecordingMediaPosition } from "../hooks/useRecordingMediaPosition";
import type { RecordingMarker } from "../types/recording";
import { playbackClock } from "../utils/player/playbackClock";
import {
  CameraOutlined,
  CloseOutlined,
  CommentOutlined,
  CompressOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { Button, Modal, Popconfirm, Popover, Space, Tooltip } from "antd";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
import { usePreviewScreenshot } from "./preview/usePreviewScreenshot";
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
  const [screenshotFrameReady, setScreenshotFrameReady] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<HTMLVideoElement | null>(
    null,
  );
  const {
    live,
    recording,
    onAir,
    busy,
    actingAction,
    activeRecordingId,
    activeRecordingRef,
    displayedTrack,
    trackClosing,
    recentStop,
    handleStart,
    handleStop,
  } = usePreviewRecording(room);
  const mediaClock = useRecordingMediaRange(
    activeRecordingId ?? displayedTrack?.id,
    previewVideo,
    room.platform === "youtube" && recording,
  );
  const trackElapsedSeconds = mediaClock.durationSeconds;
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
    trackWidth,
    videoBox,
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
    danmakuFontScale,
    danmakuSpeedMultiplier,
    setDanmakuVisible,
    setDanmakuOpacity,
    setDanmakuDensity,
    setDanmakuFontScale,
    setDanmakuSpeedMultiplier,
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
  const screenshot = usePreviewScreenshot(
    room.id,
    previewVideo,
    screenshotFrameReady,
    Boolean(displayPreview.loading),
    seekPlayback?.recordingId ?? activeRecordingId ?? displayedTrack?.id,
  );
  const media = useRecordingMediaPosition(
    activeRecordingId,
    previewVideo,
    displayPreview,
    seekPlayback,
    mediaClock,
    previewFrameGenerationRef,
  );
  const { markers, addingMarker, updateMarkers, quickAddMarker } =
    usePreviewMarkers(
      room,
      live,
      activeRecordingId,
      activeRecordingRef,
      displayPreview,
      trackClosing,
      trackElapsedSeconds,
      media.getPosition,
    );
  const segmentPreviewEnd = useRef<number | null>(null);
  const segmentPreviewActive = useRef(false);
  const seekManually = (target: number | "live", indicatorSecond?: number) => {
    segmentPreviewEnd.current = null;
    segmentPreviewActive.current = false;
    handleSeekCommit(target, indicatorSecond);
  };
  const previewSegment = (marker: RecordingMarker) => {
    handleSeekCommit(marker.positionSeconds);
    segmentPreviewEnd.current = marker.endPositionSeconds ?? null;
    segmentPreviewActive.current = true;
    void previewVideo?.play().catch(() => undefined);
  };
  useEffect(() => {
    if (
      displayPreview.mode === "history" &&
      !displayPreview.loading &&
      segmentPreviewEnd.current != null &&
      displayPreview.second != null &&
      displayPreview.second >= segmentPreviewEnd.current
    ) {
      previewVideo?.pause();
      segmentPreviewEnd.current = null;
    }
  }, [displayPreview, previewVideo]);
  useEffect(() => {
    segmentPreviewEnd.current = null;
    segmentPreviewActive.current = false;
  }, [activeRecordingId]);
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

  const playerBounds = pictureInPicture
    ? { left: picturePosition.x, top: picturePosition.y, ...pictureBox }
    : previewPlayerBounds;
  const playerStyle = {
    "--lr-preview-player-left": `${playerBounds?.left ?? 0}px`,
    "--lr-preview-player-top": `${playerBounds?.top ?? 0}px`,
    "--lr-preview-player-width": `${playerBounds?.width ?? 0}px`,
    "--lr-preview-player-height": `${playerBounds?.height ?? 0}px`,
  } as CSSProperties;

  return (
    <>
      <Modal
        open={!pictureInPicture}
        aria-owns={playerPortalId}
        title={
          <div className="lr-preview-modal__header">
            <span className="lr-preview-modal__name">{`${titlePrefix}：${room.displayName}`}</span>
            <Space size={4}>
              <Tooltip title="截图">
                <Button
                  type="text"
                  size="small"
                  aria-label="截图"
                  icon={<CameraOutlined />}
                  disabled={!screenshot.enabled}
                  loading={screenshot.saving}
                  onClick={() => void screenshot.takeScreenshot()}
                />
              </Tooltip>
              <Popover
                trigger="click"
                placement="bottomRight"
                content={
                  <DanmakuSettings
                    compact
                    visible={danmakuVisible}
                    opacity={danmakuOpacity}
                    density={danmakuDensity}
                    fontScale={danmakuFontScale}
                    speedMultiplier={danmakuSpeedMultiplier}
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
                    onFontScaleChange={setDanmakuFontScale}
                    onSpeedMultiplierChange={setDanmakuSpeedMultiplier}
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
        <div className="lr-preview-modal__body">
          <div
            className="lr-preview-modal__content"
            style={
              { "--lr-preview-track-width": `${trackWidth}px` } as CSSProperties
            }
          >
            <div
              className="lr-preview-modal__video"
              style={
                {
                  "--lr-preview-video-width": `${videoBox.width}px`,
                  "--lr-preview-video-height": `${videoBox.height}px`,
                } as CSSProperties
              }
            >
              <div
                ref={setPreviewPlayerSlot}
                className="lr-preview-modal__player-slot"
              />
            </div>
            <PreviewRecordingTrack
              roomId={room.id}
              displayedTrack={displayedTrack}
              trackClosing={trackClosing}
              trackRevealRef={trackRevealRef}
              trackGaps={trackGaps}
              trackElapsedSeconds={trackElapsedSeconds}
              markers={markers}
              quickAddMarker={quickAddMarker}
              addingMarker={addingMarker}
              displayPreview={displayPreview}
              recording={recording}
              streamHealth={streamHealth}
              handleSeekIntent={handleSeekIntent}
              handleSeekCommit={seekManually}
              seekPlayback={seekPlayback}
              seekIndexState={seekIndexState}
              seekActualStart={seekActualStart}
              updateMarkers={updateMarkers}
              media={media}
              onPreviewSegment={previewSegment}
              setTrackCollapsed={setTrackCollapsed}
            />
          </div>
          <div className="lr-preview-modal__footer">
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
                  {playbackClock(trackElapsedSeconds)}）
                </Button>
              </Popconfirm>
            ) : (
              <Space>
                <Tooltip title={!onAir ? "未开播，无法录制" : undefined}>
                  <Button
                    className="lr-preview-modal__action-button"
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
          className={[
            "lr-preview-player",
            pictureInPicture && "lr-preview-player--picture-in-picture",
            !pictureInPicture &&
              (!previewPlayerBounds || !streamRatioReady) &&
              "lr-preview-player--hidden",
            (pictureInPicture || previewPlayerVisible) &&
              "lr-preview-player--visible",
          ]
            .filter(Boolean)
            .join(" ")}
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
          style={playerStyle}
        >
          <VideoPlayer
            fill
            rememberAudio
            preserveFrameOnSwitch
            roomId={room.id}
            platform={room.platform}
            aspectRatio={streamRatio ?? undefined}
            onStreamAspectRatio={handleStreamAspectRatio}
            onVideoElementChange={setPreviewVideo}
            onFrameReadyChange={setScreenshotFrameReady}
            seek={seekPlayback}
            onSeekTail={() => {
              if (segmentPreviewActive.current) {
                previewVideo?.pause();
                segmentPreviewEnd.current = null;
              } else handleSeekTail();
            }}
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
                getVideo={() => previewVideo}
                maxBullets={danmakuDensity}
                fontScale={danmakuFontScale}
                speedMultiplier={danmakuSpeedMultiplier}
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
              className={`lr-preview-player__resize-handle${portrait ? " lr-preview-player__resize-handle--portrait" : ""}`}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
