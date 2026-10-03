import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import RecordingStopIcon from "./RecordingStopIcon";
import RecordingTrack from "./RecordingTrack";
import type { Room } from "../types/room";
import { useRoomStore } from "../stores/roomStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useDisplayClock } from "../hooks/useDisplayClock";
import { isPlausibleSeekOffset } from "../utils/recordingTimeline";
import { describeError } from "../utils/errorMap";
import { fitPreviewBox, fitPreviewBoxByHeight } from "../utils/previewLayout";
import { ApiError } from "../types/error";
import VideoPlayer from "./VideoPlayer";
import { observePreviewProgress } from "../utils/observePreviewProgress";
import {
  clearHighlightBuffer,
  disableHighlightBuffer,
  enableHighlightBuffer,
  exportHighlight,
  fetchHighlightBufferStatus,
  type HighlightBufferStatus,
} from "../api/rooms";
import {
  createRecordingMarker,
  deleteRecordingMarker,
  fetchRecordingMarkers,
  fetchRecordings,
  prewarmRecordingSeek,
  recordingSeekStreamUrl,
  updateRecordingMarker,
} from "../api/recordings";
import type { RecordingMarker } from "../types/recording";

const MIN_WIDTH = 640;
const MAX_WIDTH = 1440;
const PICTURE_IN_PICTURE_WIDTH = 360;
/** 弹窗主体左右内边距合计（antd 默认各 24）：视频区宽度 = 弹窗宽度 - 该值。 */
const MODAL_BODY_PADDING_X = 48;
/** Ant Modal 在视口两侧至少保留 16px，视频缩放也必须预留这段空间。 */
const MODAL_VIEWPORT_GUTTER_X = 32;
const MODAL_CHROME_HEIGHT = 108;
/** 轨道操作区的可用宽度下限；窄于此时才退回到视口可用宽度。 */
const RECORDING_TRACK_MIN_WIDTH = 450;
/** 竖屏拖拽缩放的画面高度下限，避免缩到不可用。 */
const MIN_VIDEO_HEIGHT = 240;
/** 秒→mm:ss（跳播真值提示用）。 */
const formatClock = (value: number) => {
  const total = Math.max(0, Math.floor(value));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
type PlayerBounds = { left: number; top: number; width: number };
type PendingPreviewResize = { portrait: boolean; value: number };

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
  // 普通观看默认占视口约 80%，同时为窄屏和超宽屏设置合理边界；直播墙全屏可传入显式宽度。
  const [width, setWidth] = useState(
    () =>
      defaultWidth ??
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.8)),
      ),
  );
  const [recentStop, setRecentStop] = useState(false);
  // 流的真实比例（宽/高）。元数据未就绪时播放器保持隐藏，避免先按 16:9 显示再缩成竖屏。
  const [streamRatio, setStreamRatio] = useState<number | null>(null);
  const [streamRatioReady, setStreamRatioReady] = useState(false);
  // 竖屏画面高度（宽度按比例算出）；null = 用满可视高度上限，用户拖拽后才取值。
  const [portraitHeight, setPortraitHeight] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [viewportHeight, setViewportHeight] = useState(
    () => window.innerHeight,
  );
  const [highlightSeconds, setHighlightSeconds] = useState(30);
  const [highlightMaxSeconds, setHighlightMaxSeconds] = useState(300);
  const [highlightAvailableSeconds, setHighlightAvailableSeconds] = useState(0);
  const [highlightDisabledReason, setHighlightDisabledReason] = useState<
    string | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [markers, setMarkers] = useState<RecordingMarker[]>([]);
  const setPendingClipExport = useRecordingStore((s) => s.setPendingClipExport);
  const [displayedTrack, setDisplayedTrack] = useState<{
    id: string;
    startedAt: string;
  } | null>(null);
  const [trackCollapsed, setTrackCollapsed] = useState(false);
  const [trackHeight, setTrackHeight] = useState(0);
  const [trackNode, setTrackNode] = useState<HTMLDivElement | null>(null);
  const [trackOccupied, setTrackOccupied] = useState(0);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [picturePosition, setPicturePosition] = useState({ x: 0, y: 0 });
  const [previewPlayerBounds, setPreviewPlayerBounds] =
    useState<PlayerBounds | null>(null);
  const [previewPlayerVisible, setPreviewPlayerVisible] = useState(false);
  const [previewPlayerSlot, setPreviewPlayerSlot] =
    useState<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startW: number;
    startY: number;
    startHeight: number;
    portrait: boolean;
  } | null>(null);
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
  const trackRevealRef = useCallback((node: HTMLDivElement | null) => {
    setTrackNode(node);
  }, []);
  const streamRatioTimerRef = useRef<number | null>(null);
  // 鼠标事件可能快于显示器刷新率；尺寸状态只在下一帧提交一次最新值。
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<PendingPreviewResize | null>(null);

  const live = rooms.find((r) => r.id === room.id) ?? room;
  const recording =
    live.monitorState === "recording" || live.monitorState === "reconnecting";
  const now = useDisplayClock(recording);
  const onAir = live.lastLiveStatus === "live";
  const busy = actingRoomId === room.id;
  const activeRecordingId = live.activeRecording?.recordingId;
  const lastStreamRatioRef = useRef<number | null>(null);
  const handleStreamAspectRatio = useCallback((ratio: number) => {
    const previous = lastStreamRatioRef.current;
    if (previous === ratio) return;
    lastStreamRatioRef.current = ratio;
    setStreamRatio(ratio);
    // 仅首次确定比例时隐藏；切流重复元数据或分辨率变化不应闪黑。
    if (previous !== null) return;
    setStreamRatioReady(false);
    if (streamRatioTimerRef.current !== null)
      window.clearTimeout(streamRatioTimerRef.current);
    streamRatioTimerRef.current = window.setTimeout(
      () => setStreamRatioReady(true),
      180,
    );
  }, []);

  useEffect(
    () => () => {
      if (streamRatioTimerRef.current !== null)
        window.clearTimeout(streamRatioTimerRef.current);
    },
    [],
  );

  const commitPendingResize = () => {
    const next = pendingResizeRef.current;
    pendingResizeRef.current = null;
    if (!next) return;
    if (next.portrait)
      setPortraitHeight((current) =>
        current === next.value ? current : next.value,
      );
    else setWidth((current) => (current === next.value ? current : next.value));
  };

  const queuePreviewResize = (next: PendingPreviewResize) => {
    pendingResizeRef.current = next;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      commitPendingResize();
    });
  };

  useEffect(
    () => () => {
      if (resizeFrameRef.current !== null)
        window.cancelAnimationFrame(resizeFrameRef.current);
    },
    [],
  );

  // 停止后保留最后一帧到退场动画结束，避免条件渲染直接卸载而闪退。
  useEffect(() => {
    if (recording && activeRecordingId && live.activeRecording?.startedAt) {
      const next = {
        id: activeRecordingId,
        startedAt: live.activeRecording.startedAt,
      };
      setDisplayedTrack((current) =>
        current?.id === next.id && current.startedAt === next.startedAt
          ? current
          : next,
      );
      return;
    }
    if (!displayedTrack) return;
    const timer = window.setTimeout(() => setDisplayedTrack(null), 1000);
    return () => window.clearTimeout(timer);
  }, [
    recording,
    activeRecordingId,
    live.activeRecording?.startedAt,
    displayedTrack,
  ]);
  const trackClosing = Boolean(displayedTrack) && !recording;
  const trackElapsedSeconds = displayedTrack
    ? Math.max(0, Math.floor((now - Date.parse(displayedTrack.startedAt)) / 1000))
    : 0;

  useEffect(() => {
    if (!activeRecordingId) {
      setMarkers([]);
      return;
    }
    void fetchRecordingMarkers(activeRecordingId)
      .then(setMarkers)
      .catch(() => setMarkers([]));
  }, [activeRecordingId]);

  useLayoutEffect(() => {
    const wrapper = trackNode;
    if (!displayedTrack || !wrapper) return;
    const node = wrapper.firstElementChild ?? wrapper;
    const update = () => {
      if (!node.isConnected) return;
      const margin = Number.parseFloat(getComputedStyle(node).marginTop) || 0;
      const reserved = Math.ceil(node.getBoundingClientRect().height + margin);
      setTrackHeight((current) => (current === reserved ? current : reserved));
      // 外层实际占位高随收放动画走：视频按它吸收变化，按钮位置不受影响。
      const occupied = Math.ceil(wrapper.getBoundingClientRect().height);
      setTrackOccupied((current) =>
        current === occupied ? current : occupied,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [displayedTrack, trackCollapsed, trackNode]);

  // 模态框尺寸只由初始预览/用户拖拽决定；轨道只从其内部视频区扣除实际高度。
  const maxModalWidth = Math.max(
    MODAL_BODY_PADDING_X + 1,
    viewportWidth - MODAL_VIEWPORT_GUTTER_X,
  );
  const maxVideoWidth = Math.max(1, maxModalWidth - MODAL_BODY_PADDING_X);
  const layoutRatio = streamRatio ?? 16 / 9;
  const portrait = layoutRatio < 1;
  const maxModalHeight = Math.max(0, viewportHeight - 32);
  const baseVideoHeight = Math.max(0, maxModalHeight - MODAL_CHROME_HEIGHT);
  const measuredTrackHeight = displayedTrack && trackNode ? trackHeight : 0;
  const occupiedTrackHeight = displayedTrack && trackNode ? trackOccupied : 0;
  // 不变量设计：内容区总高（视频+轨道预留）不参与轨道收放——弹窗高在轨道生命周期恒定、
  // 随用户拖拽贴内容；视频渲染高=内容区-占位高（轨道收放被视频吸收、按钮不位移）。
  // 拖拽上限用视口常量（base-occupied），绝不从用户当前尺寸派生（否则还原拖被自家上限锁死）。
  const reservedVideoCap = Math.max(0, baseVideoHeight - measuredTrackHeight);
  const naturalVideoHeight = portrait
    ? (portraitHeight ?? reservedVideoCap)
    : fitPreviewBox(
        layoutRatio,
        Math.min(Math.max(1, width - MODAL_BODY_PADDING_X), maxVideoWidth),
        reservedVideoCap,
      ).height;
  const contentTotalHeight =
    Math.min(naturalVideoHeight, reservedVideoCap) + measuredTrackHeight;
  const maxVideoHeight = Math.max(0, baseVideoHeight - occupiedTrackHeight);
  const videoRenderHeight = Math.max(
    0,
    contentTotalHeight - occupiedTrackHeight,
  );
  const videoBox = portrait
    ? fitPreviewBoxByHeight(layoutRatio, videoRenderHeight, videoRenderHeight)
    : fitPreviewBox(
        layoutRatio,
        Math.min(Math.max(1, width - MODAL_BODY_PADDING_X), maxVideoWidth),
        videoRenderHeight,
      );
  // 弹窗高度按「内容区+固定 chrome」，不随轨道占位变——底部按钮三态不位移。
  const modalHeight = Math.min(
    maxModalHeight,
    Math.ceil(contentTotalHeight + MODAL_CHROME_HEIGHT),
  );
  const modalWidth = Math.min(
    maxModalWidth,
    Math.max(
      MODAL_BODY_PADDING_X + Math.min(RECORDING_TRACK_MIN_WIDTH, maxVideoWidth),
      Math.min(width, maxModalWidth),
    ),
  );
  const trackWidth = Math.max(
    videoBox.width,
    Math.min(RECORDING_TRACK_MIN_WIDTH, maxVideoWidth),
  );
  // 画中画同样按真实比例，以固定宽度为基准，并且不超过窗口高度。
  const pictureBox = fitPreviewBox(
    layoutRatio,
    PICTURE_IN_PICTURE_WIDTH,
    Math.max(120, viewportHeight - 20),
  );

  // 视口变化时重算画面边界，避免横屏拖大后再缩小窗口时视频越界。
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!recentStop) return;
    const t = setTimeout(() => setRecentStop(false), 1200);
    return () => clearTimeout(t);
  }, [recentStop]);

  // 精彩时刻 enable 的代际号：StrictMode 双挂载/轮询重试会再次 enable，
  // 过期的 unmount DELETE 不得打掉新会话（否则永久 0 秒）。
  const highlightGenRef = useRef(new Map<string, number>());
  const bumpHighlightGen = (id: string) => {
    const next = (highlightGenRef.current.get(id) ?? 0) + 1;
    highlightGenRef.current.set(id, next);
    return next;
  };

  // 此组件只用于监控页/全屏普通观看；直播墙直接使用 VideoPlayer，因此不会触发缓存。
  useEffect(() => {
    if (!enableHighlights || !highlightEnabled || recording || !onAir) {
      setHighlightAvailableSeconds(0);
      setHighlightDisabledReason(null);
      return;
    }
    let alive = true;
    bumpHighlightGen(room.id);
    const applyStatus = (status: HighlightBufferStatus) => {
      if (!alive) return;
      setHighlightMaxSeconds(status.maxSeconds);
      setHighlightAvailableSeconds(status.availableSeconds);
      setHighlightDisabledReason(
        status.accepting ? null : (status.disabledReason ?? null),
      );
    };
    const refresh = () =>
      void fetchHighlightBufferStatus(room.id)
        .then((status) => {
          if (!alive) return;
          applyStatus(status);
          if (!status.enabled) {
            bumpHighlightGen(room.id);
            void enableHighlightBuffer(room.id)
              .then(applyStatus)
              .catch(() => undefined);
          }
        })
        .catch(() => alive && setHighlightAvailableSeconds(0));
    void enableHighlightBuffer(room.id)
      .then(applyStatus)
      .catch(() => alive && setHighlightAvailableSeconds(0));
    let timer: number | null = null;
    const startTick = () => {
      if (timer === null) timer = window.setInterval(refresh, 1_000);
    };
    const stopTick = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    // 后台暂停预览轮询，回前台立即刷一次再恢复（预览画面/时长显示不滞后）。
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startTick();
      } else stopTick();
    };
    if (document.visibilityState === "visible") startTick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stopTick();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [room.id, recording, onAir, enableHighlights, highlightEnabled]);

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
    let frame = window.requestAnimationFrame(() => {
      setPreviewPlayerVisible(true);
      // 逐帧跟随占位区域：下方轨道插入等布局变化只移动不缩放，RO 不报位移。
      const followSlot = () => {
        syncBounds();
        frame = window.requestAnimationFrame(followSlot);
      };
      followSlot();
    });
    const observer = new ResizeObserver(syncBounds);
    observer.observe(slot);
    window.addEventListener("resize", syncBounds);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [pictureInPicture, previewPlayerSlot]);

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

  const updateMarkers = async (
    action: () => Promise<RecordingMarker | void>,
  ) => {
    await action();
    if (activeRecordingId)
      setMarkers(await fetchRecordingMarkers(activeRecordingId));
  };

  // 导出选区：只弹「录制完成」确认框（后台零动作）；用户点保留后才启动后台导出。
  const handleClipExport = (start: number, end: number) => {
    if (!activeRecordingId) return;
    setPendingClipExport({
      recordingId: activeRecordingId,
      roomId: room.id,
      startSecond: start,
      endSecond: end,
      defaultName: `${live.displayName}_片段`,
    });
  };

  // 跳播：松手才起流，代际号防串流；拖回最右/播到已录尾=切回实时直播。
  const [seekPlayback, setSeekPlayback] = useState<{
    url: string;
    generation: number;
    second: number;
    startSecond: number;
  } | null>(null);
  const seekGenRef = useRef(0);
  const seekMarkRef = useRef<string | null>(null);
  const [seekActualStart, setSeekActualStart] = useState<{
    generation: number;
    second: number;
  } | null>(null);
  useEffect(() => {
    if (!seekActualStart) return;
    const timer = window.setTimeout(() => setSeekActualStart(null), 2000);
    return () => window.clearTimeout(timer);
  }, [seekActualStart]);
  const [previewVideo, setPreviewVideo] = useState<HTMLVideoElement | null>(
    null,
  );
  const previewFrameGenerationRef = useRef<number | null>(null);
  const requestedPlaybackRef = useRef(seekPlayback);
  requestedPlaybackRef.current = seekPlayback;
  const [displayPreview, setDisplayPreview] = useState<{
    mode: "live" | "history";
    second?: number;
    loading?: boolean;
  }>({ mode: "live" });
  useEffect(() => {
    if (!previewVideo || !seekPlayback) return;
    const generation = seekPlayback.generation;
    return observePreviewProgress(
      previewVideo,
      (elapsed) => {
        if (generation !== seekGenRef.current) return;
        setDisplayPreview({
          mode: "history",
          second: isPlausibleSeekOffset(
            seekPlayback.second,
            seekPlayback.startSecond,
          )
            ? seekPlayback.startSecond + elapsed
            : undefined,
        });
      },
      () => previewFrameGenerationRef.current === generation,
    );
  }, [previewVideo, seekPlayback]);
  const recordingSnapshot = useRecordingStore((s) =>
    activeRecordingId ? s.recordingSnapshots[activeRecordingId] : undefined,
  );
  const setRecordingSnapshot = useRecordingStore((s) => s.setRecordingSnapshot);
  const seekIndexState = recordingSnapshot?.seekIndexState ?? "ready";

  useEffect(() => {
    if (!activeRecordingId) return;
    void fetchRecordings({ roomId: room.id, pageSize: 10 })
      .then((res) => {
        const rec = res.items.find((item) => item.id === activeRecordingId);
        if (rec) setRecordingSnapshot(rec);
      })
      .catch(() => undefined);
  }, [activeRecordingId, room.id, setRecordingSnapshot]);

  const handleSeekIntent = useCallback(
    (second: number) => {
      if (!activeRecordingId) return;
      void prewarmRecordingSeek(activeRecordingId, second).catch(
        () => undefined,
      );
    },
    [activeRecordingId],
  );
  const lastSeekCommitRef = useRef<{
    target: number | "live";
    at: number;
  } | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const handleSeekCommit = useCallback(
    (target: number | "live", indicatorSecond?: number) => {
      // 同目标在途即忽略（状态语义去重，不按时间窗）：双柄同帧/事件重发/内核再请求
      // 都不再产生第二次起流。
      const nowTs = Date.now();
      const lastCommit = lastSeekCommitRef.current;
      if (lastCommit && lastCommit.target === target) {
        if (indicatorSecond != null)
          setDisplayPreview((current) => ({ ...current, second: indicatorSecond }));
        return;
      }
      lastSeekCommitRef.current = { target, at: nowTs };
      pendingSeekRef.current = null;
      if (target === "live") {
        seekGenRef.current += 1;
        if (requestedPlaybackRef.current) {
          setDisplayPreview((current) => ({
            ...current,
            second: indicatorSecond ?? (
              current.mode === "live" && !current.loading
                ? trackElapsedSeconds
                : current.second
            ),
            loading: true,
          }));
        } else setDisplayPreview({ mode: "live" });
        setSeekPlayback(null);
        try {
          performance.mark("lr-seek:to-live");
        } catch {
          /* 性能 API 不可用时静默 */
        }
        return;
      }
      if (!activeRecordingId) return;
      const generation = ++seekGenRef.current;
      setDisplayPreview((current) => ({
        ...current,
        second: indicatorSecond ?? (
          current.mode === "live" && !current.loading
            ? trackElapsedSeconds
            : current.second
        ),
        loading: true,
      }));
      if (seekIndexState === "building") {
        // 索引未就绪：不弹 toast（轨道已有「正在加载」提示），记下拖拽意图，
        // 就绪后自动落点，用户无需再拖一次。
        pendingSeekRef.current = target;
        return;
      }
      seekMarkRef.current = `lr-seek:pointerup-${generation}`;
      try {
        performance.mark(seekMarkRef.current);
      } catch {
        /* 性能 API 不可用时静默 */
      }
      // 先取得解码起点，再把目标与起点一起交给播放器完成准确定位。
      void prewarmRecordingSeek(activeRecordingId, target)
        .then((res) => {
          if (generation !== seekGenRef.current) return;
          if (res?.startSecond == null || !Number.isFinite(res.startSecond)) {
            throw new Error("回看定位信息缺失，请重试");
          }
          setSeekPlayback({
            url: recordingSeekStreamUrl(activeRecordingId, target),
            generation,
            second: target,
            startSecond: res.startSecond,
          });
        })
        .catch((error: unknown) => {
          if (generation !== seekGenRef.current) return;
          lastSeekCommitRef.current = null;
          // 索引未就绪类拒绝（可重试）＝同「正在加载」：挂起意图等就绪自动落点，不弹 toast。
          if (error instanceof ApiError && error.retryable) {
            pendingSeekRef.current = target;
            return;
          }
          setDisplayPreview((current) => ({ ...current, loading: false }));
          message.error(
            error instanceof ApiError
              ? describeError(error.code, error.message)
              : error instanceof Error
                ? error.message
                : "回看定位失败，请重试",
          );
        });
    },
    [activeRecordingId, seekIndexState, message, trackElapsedSeconds],
  );
  const handleSeekTail = useCallback(() => {
    lastSeekCommitRef.current = null;
    seekGenRef.current += 1;
    setSeekPlayback(null);
    setDisplayPreview((current) => ({ ...current, loading: true }));
    pendingSeekRef.current = null;
  }, []);
  // 索引就绪后自动落点：挂起的拖拽意图自动触发回看，无需用户再拖一次。
  const handleSeekCommitRef = useRef(handleSeekCommit);
  useEffect(() => {
    handleSeekCommitRef.current = handleSeekCommit;
  });
  useEffect(() => {
    if (seekIndexState !== "ready") return;
    const target = pendingSeekRef.current;
    if (target == null) return;
    pendingSeekRef.current = null;
    // 自动落点必须绕过「同目标在途去重」（此前那次已被拒非在途）。
    lastSeekCommitRef.current = null;
    handleSeekCommitRef.current(target);
  }, [seekIndexState]);
  // 录制停止/入口消失即清挂起意图，不让它泄漏到下一次录制。
  useEffect(() => {
    if (!activeRecordingId) pendingSeekRef.current = null;
  }, [activeRecordingId]);
  const handleSeekFirstFrame = useCallback((generation: number) => {
    if (generation !== seekGenRef.current) return;
    lastSeekCommitRef.current = null;
    previewFrameGenerationRef.current = generation;
    const playback = requestedPlaybackRef.current;
    if (playback?.generation === generation) {
      setDisplayPreview({ mode: "history", second: playback.second });
      setSeekActualStart({ generation, second: playback.second });
    }
    if (!seekMarkRef.current) return;
    try {
      performance.measure(
        `lr-seek:to-first-frame-${generation}`,
        seekMarkRef.current,
      );
    } catch {
      /* 性能 API 不可用时静默 */
    }
    seekMarkRef.current = null;
  }, []);
  const handleLiveFirstFrame = useCallback(() => {
    if (requestedPlaybackRef.current) return;
    if (typeof lastSeekCommitRef.current?.target === "number") return;
    lastSeekCommitRef.current = null;
    setDisplayPreview({ mode: "live" });
    try {
      performance.measure("lr-seek:to-live-first-frame", "lr-seek:to-live");
    } catch {
      /* 无切直播打点时静默 */
    }
  }, []);

  const handleClose = () => {
    if (enableHighlights)
      void disableHighlightBuffer(room.id).catch(() => undefined);
    onClose();
  };

  useEffect(() => {
    const roomId = room.id;
    return () => {
      if (!enableHighlights) return;
      const gen = highlightGenRef.current.get(roomId) ?? 0;
      window.setTimeout(() => {
        if ((highlightGenRef.current.get(roomId) ?? 0) !== gen) return;
        void disableHighlightBuffer(roomId).catch(() => undefined);
      }, 150);
    };
  }, [disableHighlightBuffer, enableHighlights, room.id]);

  const enterPictureInPicture = () => {
    setPreviewPlayerVisible(false);
    setPicturePosition({
      x: Math.max(10, window.innerWidth - pictureBox.width - 10),
      y: Math.max(10, window.innerHeight - pictureBox.height - 10),
    });
    setPictureInPicture(true);
  };

  const resumePictureVideo = () => {
    if (!pictureWasPlayingRef.current) return;
    const video = pictureVideoRef.current;
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
          Math.min(window.innerWidth - pictureBox.width, drag.originX + deltaX),
        ),
        y: Math.max(
          0,
          Math.min(
            window.innerHeight - pictureBox.height,
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
      resumePictureVideo();
    }
    suppressPictureClickRef.current = false;
  };

  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startW: width,
      startY: e.clientY,
      startHeight: videoBox.height,
      portrait,
    };
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.portrait) {
        // 竖屏尺寸由高度决定，所以用纵向拖拽缩放；上限仍是可视高度，不会推出屏幕。
        queuePreviewResize({
          portrait: true,
          value: Math.min(
            maxVideoHeight,
            Math.max(
              MIN_VIDEO_HEIGHT,
              drag.startHeight + (ev.clientY - drag.startY),
            ),
          ),
        });
        return;
      }
      queuePreviewResize({
        portrait: false,
        value: Math.min(
          MAX_WIDTH,
          maxModalWidth,
          Math.max(
            Math.min(MIN_WIDTH, maxModalWidth),
            drag.startW + (ev.clientX - drag.startX),
          ),
        ),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      // 释放鼠标时立刻提交尚未等到下一帧的末尾位置。
      commitPendingResize();
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
            <span className="lr-preview-modal__name">{`${titlePrefix}：${room.displayName}`}</span>
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
        <div
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
          <div
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              ref={setPreviewPlayerSlot}
              style={{
                position: "relative",
                background: "#000",
                overflow: "hidden",
                margin: "0 auto",
                width: videoBox.width,
                height: videoBox.height,
                flexShrink: 1,
                minHeight: 0,
                willChange: "width, height",
              }}
            />
            {displayedTrack ? (
              <div
                ref={trackRevealRef}
                className={`lr-recording-track-reveal${trackClosing ? " lr-recording-track-reveal--closing" : ""}`}
                style={{
                  width: trackWidth,
                  margin: "0 auto",
                  flexShrink: 1,
                  minHeight: 0,
                }}
              >
                <RecordingTrack
                  elapsedSeconds={trackElapsedSeconds}
                  markers={markers}
                  editable
                  onSeekIntent={handleSeekIntent}
                  onSeekCommit={handleSeekCommit}
                  onReturnToLive={
                    seekPlayback ? () => handleSeekCommit("live") : undefined
                  }
                  previewMode={displayPreview.mode}
                  previewSecond={displayPreview.second}
                  previewLoading={displayPreview.loading}
                  seekHint={
                    seekIndexState === "building"
                      ? "正在加载…"
                      : seekActualStart != null
                        ? `从 ${formatClock(seekActualStart.second)} 起播`
                        : undefined
                  }
                  onAdd={(text) =>
                    updateMarkers(() =>
                      createRecordingMarker(
                        displayedTrack.id,
                        text,
                        // 标记落在当前预览位置（播放头真值）；直播中不传=服务端按当前时刻=尾部语义不变。
                        displayPreview.mode === "history" &&
                          displayPreview.second != null
                          ? Math.floor(displayPreview.second)
                          : undefined,
                      ),
                    )
                  }
                  onEdit={(markerId, text) =>
                    updateMarkers(() =>
                      updateRecordingMarker(displayedTrack.id, markerId, {
                        text,
                      }),
                    )
                  }
                  onMove={(markerId, positionSeconds) =>
                    updateMarkers(() =>
                      updateRecordingMarker(displayedTrack.id, markerId, {
                        positionSeconds,
                      }),
                    )
                  }
                  onDelete={(markerId) =>
                    updateMarkers(() =>
                      deleteRecordingMarker(displayedTrack.id, markerId),
                    )
                  }
                  onExport={handleClipExport}
                  onCollapsedChange={setTrackCollapsed}
                />
              </div>
            ) : null}
          </div>
          <div
            style={{
              flexShrink: 0,
              marginTop: 12,
              textAlign: "center",
            }}
          >
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
              ? pictureBox.width
              : (previewPlayerBounds?.width ?? 0),
            height: pictureInPicture ? pictureBox.height : undefined,
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
            preserveFrameOnSwitch
            roomId={room.id}
            platform={room.platform}
            aspectRatio={streamRatio ?? undefined}
            onStreamAspectRatio={handleStreamAspectRatio}
            onVideoElementChange={setPreviewVideo}
            seek={seekPlayback}
            onSeekTail={handleSeekTail}
            onSeekFirstFrame={handleSeekFirstFrame}
            onLiveFirstFrame={handleLiveFirstFrame}
          />
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
