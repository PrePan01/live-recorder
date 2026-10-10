import { promptRangeExport } from "../utils/promptRangeExport";
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Modal, Select, Typography } from "antd";
import {
  PauseOutlined,
  CaretRightOutlined,
  ExportOutlined,
  SoundOutlined,
  MutedOutlined,
} from "@ant-design/icons";
import mpegts from "mpegts.js";
import { recordingFileUrl } from "../api/recordings";
import {
  createRecordingMarker,
  deleteRecordingMarker,
} from "../api/recordings";
import { useSegmentMarking } from "../hooks/useSegmentMarking";
import { useSegmentExport } from "../hooks/useSegmentExport";
import { SegmentExportActions } from "./SegmentExportActions";
import { SegmentMarkActions } from "./SegmentMarkActions";
import { fetchDanmakuWindow } from "../api/danmakuWindow";
import { exportDanmaku } from "../api/danmaku";
import { pickDirectory } from "../api/config";
import { ApiError } from "../types/error";
import { describeError } from "../utils/errorMap";
import { DanmakuLayer } from "./DanmakuLayer";
import RecordingTrack from "./RecordingTrack";
import { MarkerNavPanel } from "./MarkerNavPanel";
import DanmakuSettings from "./DanmakuSettings";
import {
  fetchRecordingGaps,
  fetchRecordingMarkers,
  updateRecordingMarker,
} from "../api/recordings";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import { useDanmakuPrefsStore } from "../stores/danmakuPrefsStore";
import type { DanmakuGap, DanmakuMessage } from "../types/danmaku";

const PLAYBACK_RATES = Array.from({ length: 11 }, (_, index) => {
  const value = 0.5 + index * 0.25;
  return { value, label: `${value}×` };
});

interface DanmakuPlayerModalProps {
  recordingId: string;
  roomId?: string;
  title: string;
  /** 完成态文件路径：决定原生 mp4 播放还是 FLV 流式播放。 */
  filePath?: string;
  /** 整条录像的弹幕状态，不受当前播放时段是否有弹幕影响。 */
  hasDanmaku?: boolean;
  /** 定位起播秒（缺口定位用）；就绪后跳到该点。 */
  initialSecond?: number;
  onClose: () => void;
}

/**
 * 弹幕回看宿主：完成态文件播放 + 弹幕飘屏。
 * mp4 走原生 video、FLV 走 mpegts（同一文件路由）；媒体时间=文件时间轴 0 基，
 * 弹幕按媒体时间加载，跳播换表清屏，暂停/倍速由媒体时间驱动天然同步。
 */
export function DanmakuPlayerModal({
  recordingId,
  roomId,
  title,
  filePath,
  hasDanmaku = false,
  initialSecond = 0,
  onClose,
}: DanmakuPlayerModalProps) {
  const { message } = App.useApp();
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef(false);
  const previewEnd = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Modal 的内容会延迟挂载；元素就绪后再绑定流式播放器。
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null,
  );
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setVideoElement(element);
  }, []);
  const playerRef = useRef<mpegts.Player | null>(null);
  const initialSeekAppliedRef = useRef(false);
  const autoplayAttemptedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadedWindowRef = useRef({ from: -1, to: -1 });
  const loadingRef = useRef(false);
  const [messages, setMessages] = useState<DanmakuMessage[]>([]);
  const [gaps, setGaps] = useState<DanmakuGap[]>([]);
  const { visible, opacity, density, setVisible, setOpacity, setDensity } =
    useDanmakuPrefsStore();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [seekTick, setSeekTick] = useState(0);
  const [markers, setMarkers] = useState<RecordingMarker[]>([]);
  const [videoGaps, setVideoGaps] = useState<RecordingGap[]>([]);
  const [failed, setFailed] = useState(false);
  // 文件回看展示读取结果；采集器在录制结束后 unavailable 不代表文件不可用。
  const [danmakuStatusText, setDanmakuStatusText] = useState("弹幕加载中");
  const isNative = (filePath ?? "").toLowerCase().endsWith(".mp4");
  const fileUrl = recordingFileUrl(recordingId);

  const getTimeMs = useCallback(
    () => (videoRef.current?.currentTime ?? 0) * 1000,
    [],
  );

  const reload = useCallback(
    async (atMs: number) => {
      const seq = ++loadSeqRef.current;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      loadingRef.current = true;
      setDanmakuStatusText("弹幕加载中");
      const from = Math.max(0, atMs - 15_000);
      const to = atMs + 30_000;
      try {
        const data = await fetchDanmakuWindow(
          recordingId,
          from,
          to,
          controller.signal,
        );
        if (seq !== loadSeqRef.current) return;
        loadedWindowRef.current = { from, to };
        setMessages(data.messages);
        setGaps(data.gaps ?? []);
        setDanmakuStatusText(data.messages.length ? "" : "当前时段暂无弹幕");
      } catch {
        if (seq !== loadSeqRef.current) return;
        setMessages([]);
        setGaps([]);
        setDanmakuStatusText("弹幕加载失败");
      } finally {
        if (seq === loadSeqRef.current) loadingRef.current = false;
      }
    },
    [recordingId],
  );

  useEffect(() => {
    initialSeekAppliedRef.current = false;
    autoplayAttemptedRef.current = false;
    void fetchRecordingMarkers(recordingId)
      .then(setMarkers)
      .catch(() => undefined);
    void fetchRecordingGaps(recordingId)
      .then(setVideoGaps)
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      const at = getTimeMs();
      const window = loadedWindowRef.current;
      if (
        initialSeekAppliedRef.current &&
        !loadingRef.current &&
        (at < window.from || at > window.to - 10_000)
      )
        void reload(at);
    }, 500);
    return () => {
      window.clearInterval(timer);
      ++loadSeqRef.current;
      loadAbortRef.current?.abort();
    };
  }, [reload, recordingId, initialSecond, getTimeMs]);

  // FLV 走 mpegts 绑源；mp4 由 JSX src 直绑（原生）。
  useEffect(() => {
    if (isNative) return undefined;
    const video = videoElement;
    if (!video) return undefined;
    const player = mpegts.createPlayer(
      {
        type: filePath?.toLowerCase().endsWith(".ts") ? "mpegts" : "flv",
        url: fileUrl,
        isLive: false,
      },
      { enableStashBuffer: false, accurateSeek: true },
    );
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, () => {
      setFailed(true);
      setPlaying(false);
    });
    player.load();
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [isNative, fileUrl, filePath, videoElement]);

  const seek = useCallback(
    (second: number, mediaDuration = duration) => {
      const video = videoRef.current;
      if (
        !video ||
        failed ||
        !Number.isFinite(second) ||
        !Number.isFinite(mediaDuration) ||
        mediaDuration <= 0
      )
        return;
      const target = Math.max(0, Math.min(mediaDuration, second));
      video.currentTime = target;
      setCurrent(video.currentTime);
      setMessages([]);
      setGaps([]);
      setSeekTick((tick) => tick + 1);
      void reload(video.currentTime * 1000);
    },
    [duration, failed, reload],
  );

  const [selectingRange, setSelectingRange] = useState(false);
  const [editingRange, setEditingRange] = useState<{
    marker: RecordingMarker;
    range: [number, number];
  } | null>(null);
  const [rangeSaving, setRangeSaving] = useState(false);
  const savedMarker = useCallback(
    (marker: RecordingMarker) =>
      setMarkers((items) => [
        ...items.filter((m) => m.id !== marker.id),
        marker,
      ]),
    [],
  );
  const getPosition = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.seeking || failed)
      throw new Error("画面尚未就绪");
    return video.currentTime;
  }, [failed]);
  const marking = useSegmentMarking(
    recordingId,
    markers,
    getPosition,
    savedMarker,
    failed || duration <= 0 || editingRange != null || selectingRange,
  );
  const exports = useSegmentExport(recordingId, markers);
  const updateMarker = async (
    marker: RecordingMarker,
    patch: {
      text?: string;
      positionSeconds?: number;
      endPositionSeconds?: number;
    },
  ) => {
    try {
      savedMarker(await updateRecordingMarker(recordingId, marker.id, patch));
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "标记保存失败",
      );
      throw error;
    }
  };
  const removeMarker = async (marker: RecordingMarker) => {
    try {
      await deleteRecordingMarker(recordingId, marker.id);
      setMarkers((items) => items.filter((m) => m.id !== marker.id));
      if (editingRange?.marker.id === marker.id) setEditingRange(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
      throw error;
    }
  };
  const addLabel = useCallback(
    async (text: string, second: number) => {
      try {
        savedMarker(
          await createRecordingMarker(recordingId, text, second),
        );
      } catch (error) {
        message.error(error instanceof Error ? error.message : "标记保存失败");
        throw error;
      }
    },
    [recordingId, savedMarker, message],
  );
  const quickAddLabel = useCallback(() => {
    const index =
      markers.reduce(
        (max, m) =>
          Math.max(max, Number(/^标记 (\d+)$/.exec(m.text)?.[1] ?? 0)),
        0,
      ) + 1;
    if (!videoRef.current || videoRef.current.readyState < 2 || videoRef.current.seeking || failed) {
      message.error("播放位置尚未就绪，请稍后重试");
      return;
    }
    void getPosition().then(second => addLabel(`标记 ${index}`, second)).catch(
      () => undefined,
    );
  }, [markers, addLabel, getPosition, failed, message]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        failed ||
        duration <= 0 ||
        e.repeat ||
        !e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.code !== "KeyM" ||
        (e.target as HTMLElement | null)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      e.preventDefault();
      quickAddLabel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [quickAddLabel, failed, duration]);
  useEffect(() => {
    setEditingRange(null);
    previewEnd.current = null;
  }, [recordingId]);
  const seekManually = (second: number) => {
    previewEnd.current = null;
    seek(second);
  };

  const updateDuration = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0)
      return;
    setDuration(video.duration);
    if (!initialSeekAppliedRef.current) {
      initialSeekAppliedRef.current = true;
      seek(initialSecond, video.duration);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || failed) return;
    if (video.paused) {
      if (video.ended || (duration > 0 && video.currentTime >= duration))
        seek(0);
      void video.play().catch(() => undefined);
    } else video.pause();
  };
  const seekDisabled = failed || duration <= 0;
  const handleExportDanmaku = async () => {
    const video = videoRef.current;
    if (exportBusyRef.current || !video || duration <= 0) return;
    exportBusyRef.current = true;
    setExporting(true);
    try {
      const directory = await pickDirectory();
      if (!directory) return;
      const result = await exportDanmaku(recordingId, {
        directory,
        durationMs: Math.floor(duration * 1000),
        width: video.videoWidth || 1920,
        height: video.videoHeight || 1080,
        opacity,
        density,
      });
      message.success(
        `已导出至 ${directory}（ASS ${result.assCount} 条，SRT ${result.count} 条）`,
      );
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "弹幕导出失败，请重试",
      );
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  return (
    <Modal
      open
      width={960}
      className="lr-danmaku-player-modal"
      title={<Typography.Text strong>{title}</Typography.Text>}
      footer={
        <Button size="small" onClick={onClose}>
          关闭
        </Button>
      }
      onCancel={onClose}
    >
      <div className="lr-danmaku-player__video">
        {failed ? (
          <div className="lr-danmaku-player__error" role="alert">
            视频加载失败，请关闭后重试
          </div>
        ) : null}
        <video
          ref={attachVideo}
          playsInline
          src={isNative ? fileUrl : undefined}
          style={{ width: "100%", height: "100%", display: "block" }}
          onPlay={() => {
            setPlaying(true);
            setFailed(false);
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (v) {
              if (
                previewEnd.current != null &&
                v.currentTime >= previewEnd.current
              ) {
                v.pause();
                v.currentTime = previewEnd.current;
                previewEnd.current = null;
              }
              setCurrent(v.currentTime);
            }
          }}
          onCanPlay={() => {
            updateDuration();
            const video = videoRef.current;
            if (!video || autoplayAttemptedRef.current || failed) return;
            autoplayAttemptedRef.current = true;
            // 每次打开只尝试一次，后续跳播或手动暂停不会触发自动播放。
            void video.play().catch(() => undefined);
          }}
          onLoadedMetadata={updateDuration}
          onDurationChange={updateDuration}
          onEnded={() => setPlaying(false)}
          onRateChange={() => setRate(videoRef.current?.playbackRate ?? 1)}
          onVolumeChange={(event) => {
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onError={() => {
            setFailed(true);
            setPlaying(false);
          }}
          onClick={togglePlay}
        />
        <DanmakuLayer
          messages={messages}
          gaps={gaps}
          getTimeMs={getTimeMs}
          maxBullets={density}
          opacity={opacity}
          visible={visible}
          resetKey={seekTick}
        />
        <Button
          className="lr-danmaku-player__toggle"
          shape="circle"
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停" : "播放"}
          icon={playing ? <PauseOutlined /> : <CaretRightOutlined />}
          onClick={togglePlay}
          disabled={failed}
        />
        <div
          className="lr-danmaku-player__volume"
          role="group"
          aria-label="音量控制"
        >
          <Button
            size="small"
            aria-label={muted || volume === 0 ? "取消静音" : "静音"}
            aria-pressed={muted || volume === 0}
            title={muted || volume === 0 ? "取消静音" : "静音"}
            icon={muted || volume === 0 ? <MutedOutlined /> : <SoundOutlined />}
            disabled={failed}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.volume === 0) {
                video.volume = 1;
                video.muted = false;
              } else video.muted = !video.muted;
            }}
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            aria-label="视频音量"
            aria-valuetext={`${muted ? 0 : Math.round(volume * 100)}%`}
            value={muted ? 0 : Math.round(volume * 100)}
            disabled={failed}
            onChange={(event) => {
              const video = videoRef.current;
              if (!video) return;
              const nextVolume = Number(event.currentTarget.value) / 100;
              video.volume = nextVolume;
              video.muted = nextVolume === 0;
            }}
          />
          <output>{muted ? 0 : Math.round(volume * 100)}%</output>
        </div>
      </div>
      <div className="lr-danmaku-player__panel">
        <RecordingTrack
          key={recordingId}
          onExport={(start, end) => promptRangeExport(recordingId, roomId ?? "", start, end)}
          selectionDisabled={failed || duration <= 0 || marking.saving || marking.start != null}
          onSelectionChange={setSelectingRange}
          segmentActions={
            <SegmentMarkActions
              marking={marking}
              current={current}
              disabled={failed || duration <= 0 || editingRange != null || selectingRange}
            >
              <SegmentExportActions
                exports={exports}
                disabled={failed || duration <= 0 || editingRange != null}
              />
            </SegmentMarkActions>
          }
          temporarySegment={
            marking.start != null
              ? [marking.start, marking.end ?? current]
              : null
          }
          rangeSelection={editingRange?.range ?? null}
          busy={rangeSaving}
          onSaveRange={async (start, end) => {
            if (!editingRange || rangeSaving) return;
            setRangeSaving(true);
            try {
              await updateMarker(editingRange.marker, {
                positionSeconds: start,
                endPositionSeconds: end,
              });
              setEditingRange(null);
            } catch {
              /* preserve adjustment for retry */
            } finally {
              setRangeSaving(false);
            }
          }}
          onCancelRange={() => setEditingRange(null)}
          onAdd={addLabel}
          onQuickAdd={quickAddLabel}
          onEdit={async (id, text) => {
            const marker = markers.find((m) => m.id === id);
            if (marker) await updateMarker(marker, { text });
          }}
          onMove={async (id, positionSeconds) => {
            const marker = markers.find((m) => m.id === id);
            if (marker) await updateMarker(marker, { positionSeconds });
          }}
          onDelete={async (id) => {
            const marker = markers.find((m) => m.id === id);
            if (marker) await removeMarker(marker);
          }}
          elapsedSeconds={duration}
          markers={markers}
          editable
          gaps={videoGaps}
          mode="playback"
          previewMode="history"
          previewSecond={current}
          getMarkerPosition={getPosition}
          seekDisabled={seekDisabled}
          toolbar={
            <>
              <span className="lr-danmaku-player__section-title">播放进度</span>
              <div className="lr-danmaku-player__rate">
                <span>播放倍速</span>
                <Select
                  size="small"
                  aria-label="播放倍速"
                  value={rate}
                  options={PLAYBACK_RATES}
                  onChange={(value) => {
                    setRate(value);
                    if (videoRef.current) videoRef.current.playbackRate = value;
                  }}
                />
              </div>
            </>
          }
          onSeekCommit={(target) => {
            if (typeof target === "number") seekManually(target);
          }}
        >
          <MarkerNavPanel
            key={recordingId}
            markers={markers}
            gaps={videoGaps}
            currentSecond={current}
            duration={duration}
            liveMode={false}
            blockedReason={
              failed
                ? "录像播放失败，暂不可定位"
                : duration <= 0
                  ? "录像加载中"
                  : undefined
            }
            onSeek={seekManually}
            onEdit={(marker, text) => updateMarker(marker, { text })}
            onRangeEdit={(marker, start, end) =>
              updateMarker(marker, {
                positionSeconds: start,
                endPositionSeconds: end,
              })
            }
            onAdjustRange={marking.start != null || marking.saving ? undefined : (marker) =>
              setEditingRange({
                marker,
                range: [marker.positionSeconds, marker.endPositionSeconds!],
              })
            }
            onDelete={removeMarker}
            onPreview={(marker) => {
              seek(marker.positionSeconds);
              previewEnd.current = marker.endPositionSeconds ?? null;
              void videoRef.current?.play().catch(() => undefined);
            }}
            selectingSegments={exports.selecting}
            selectedSegmentIds={exports.selectedSet}
            onSelectSegment={exports.select}
            exportBusy={exports.busy}
          />
        </RecordingTrack>
        <DanmakuSettings
          visible={visible}
          opacity={opacity}
          density={density}
          statusText={danmakuStatusText}
          onVisibleChange={setVisible}
          onOpacityChange={setOpacity}
          onDensityChange={setDensity}
          actions={hasDanmaku ? (
            <Button
              size="small"
              className="lr-danmaku-player__export"
              icon={<ExportOutlined />}
              loading={exporting}
              disabled={seekDisabled}
              title="导出整段录像的 ASS 滚动弹幕和 SRT 字幕"
              onClick={() => {
                void handleExportDanmaku();
              }}
            >
              导出弹幕
            </Button>
          ) : undefined}
        />
      </div>
    </Modal>
  );
}
