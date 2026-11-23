import { useMouseDrag } from "../../hooks/useMouseDrag";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  fitPreviewBox,
  fitPreviewContent,
} from "../../utils/player/previewLayout";
import {
  LIVE_DANMAKU_LIST_GAP,
  danmakuListReservedWidth,
} from "../../utils/danmaku/danmakuListLayout";
import { readPref, writePref } from "../../utils/prefStorage";

const MIN_WIDTH = 640;
const MAX_WIDTH = 1440;
const PICTURE_IN_PICTURE_WIDTH = 360;
const MODAL_BODY_PADDING_X = 48;
const PREVIEW_SIDE_SPACE = 2 * (24 + 10) + 32;
const MODAL_VIEWPORT_GUTTER_X = 32;
const MODAL_CHROME_HEIGHT = 108;
const RECORDING_TRACK_MIN_WIDTH = 450;
const MIN_VIDEO_HEIGHT = 240;
const LANDSCAPE_WIDTH_KEY = "lr-preview-landscape-width";
const PORTRAIT_HEIGHT_KEY = "lr-preview-portrait-height";
type PlayerBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type PendingPreviewResize = { portrait: boolean; value: number | null };

function readPreviewSize(key: string): number | null {
  const value = readPref<unknown>(key, null);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function usePreviewLayout(
  defaultWidth: number | undefined,
  displayedTrack: { id: string; startedAt: string } | null,
  danmakuListVisible: boolean,
) {
  const startMouseDrag = useMouseDrag();
  // 普通观看默认占视口约 80%，同时为窄屏和超宽屏设置合理边界；直播墙全屏可传入显式宽度。
  const [initialWidth] = useState(
    () =>
      defaultWidth ??
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.8)),
      ),
  );
  const [landscapeWidth, setLandscapeWidth] = useState(() =>
    readPreviewSize(LANDSCAPE_WIDTH_KEY),
  );
  const [streamRatio, setStreamRatio] = useState<number | null>(null);
  const [streamRatioReady, setStreamRatioReady] = useState(false);
  const [portraitHeight, setPortraitHeight] = useState(() =>
    readPreviewSize(PORTRAIT_HEIGHT_KEY),
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [viewportHeight, setViewportHeight] = useState(
    () => window.innerHeight,
  );
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
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<PendingPreviewResize | null>(null);

  const lastStreamRatioRef = useRef<number | null>(null);
  const handleStreamAspectRatio = useCallback((ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
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
    if (next.portrait) setPortraitHeight(next.value);
    else setLandscapeWidth(next.value);
  };

  const queuePreviewResize = (next: PendingPreviewResize) => {
    pendingResizeRef.current = next;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      commitPendingResize();
    });
  };

  const cancelResizeFrame = () => {
    if (resizeFrameRef.current === null) return;
    window.cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = null;
  };

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

  const layoutRatio = streamRatio ?? 16 / 9;
  const portrait = layoutRatio < 1;
  const preferredLandscapeWidth = portrait ? null : landscapeWidth;
  const hasSidePanel = danmakuListVisible && !pictureInPicture;
  const reservedWidth = hasSidePanel
    ? danmakuListReservedWidth(portrait, LIVE_DANMAKU_LIST_GAP)
    : MODAL_VIEWPORT_GUTTER_X;
  const maxModalWidth = Math.max(
    MODAL_BODY_PADDING_X + 1,
    viewportWidth - reservedWidth,
  );
  const maxVideoWidth = Math.max(1, maxModalWidth - MODAL_BODY_PADDING_X);
  const preferredModalWidth = Math.min(
    maxModalWidth,
    Math.max(
      MODAL_BODY_PADDING_X + Math.min(RECORDING_TRACK_MIN_WIDTH, maxVideoWidth),
      Math.min(preferredLandscapeWidth ?? initialWidth, maxModalWidth),
    ),
  );
  const compact = hasSidePanel && preferredModalWidth === maxModalWidth;
  const availableWidth = Math.max(
    1,
    preferredModalWidth - (compact ? PREVIEW_SIDE_SPACE : MODAL_BODY_PADDING_X),
  );
  const maxModalHeight = Math.max(0, viewportHeight - 32);
  const baseVideoHeight = Math.max(0, maxModalHeight - MODAL_CHROME_HEIGHT);
  const measuredTrackHeight = displayedTrack && trackNode ? trackHeight : 0;
  const occupiedTrackHeight = displayedTrack && trackNode ? trackOccupied : 0;
  const {
    videoBox,
    contentHeight,
    trackWidth: preferredTrackWidth,
  } = fitPreviewContent({
    ratio: layoutRatio,
    availableWidth,
    availableHeight: baseVideoHeight,
    trackHeight: measuredTrackHeight,
    occupiedTrackHeight,
    preferredVideoHeight: portrait ? (portraitHeight ?? undefined) : undefined,
  });
  // 默认弹窗跟随画面宽度收窄，竖屏仍给录制时间轴留出操作空间。
  const minContentModalWidth = portrait
    ? RECORDING_TRACK_MIN_WIDTH + PREVIEW_SIDE_SPACE
    : MIN_WIDTH;
  const modalWidth =
    layoutRatio !== 1 &&
    defaultWidth === undefined &&
    preferredLandscapeWidth === null
      ? Math.min(
          preferredModalWidth,
          Math.max(
            minContentModalWidth,
            Math.ceil(videoBox.width + PREVIEW_SIDE_SPACE),
          ),
        )
      : preferredModalWidth;
  // 竖屏弹窗可能继续随画面收窄，时间轴以最终弹窗宽度为上限。
  const trackWidth = portrait
    ? Math.min(
        compact ? availableWidth : preferredTrackWidth,
        Math.max(1, modalWidth - PREVIEW_SIDE_SPACE),
      )
    : preferredTrackWidth;
  const modalHeight = Math.min(
    maxModalHeight,
    Math.ceil(contentHeight + MODAL_CHROME_HEIGHT),
  );
  const pictureBox = fitPreviewBox(
    layoutRatio,
    Math.max(0, Math.min(PICTURE_IN_PICTURE_WIDTH, viewportWidth - 20)),
    Math.max(0, viewportHeight - 20),
  );

  // 窗口缩小或直播比例变化时，将画中画重新约束在视口内。
  useEffect(() => {
    if (!pictureInPicture) return;
    setPicturePosition((current) => {
      const x = Math.max(
        0,
        Math.min(current.x, viewportWidth - pictureBox.width),
      );
      const y = Math.max(
        0,
        Math.min(current.y, viewportHeight - pictureBox.height),
      );
      return x === current.x && y === current.y ? current : { x, y };
    });
  }, [
    pictureInPicture,
    viewportWidth,
    viewportHeight,
    pictureBox.width,
    pictureBox.height,
  ]);

  // 视口变化时重算画面边界，避免横屏拖大后再缩小窗口时视频越界。
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (pictureInPicture || !previewPlayerSlot) {
      setPreviewPlayerVisible(false);
      return;
    }
    const slot = previewPlayerSlot;
    const syncBounds = () => {
      // Portal 不受弹窗 flex 收缩和裁切约束，必须同步占位容器的实际宽高。
      const {
        left,
        top,
        width: nextWidth,
        height: nextHeight,
      } = slot.getBoundingClientRect();
      setPreviewPlayerBounds((current) =>
        current &&
        current.left === left &&
        current.top === top &&
        current.width === nextWidth &&
        current.height === nextHeight
          ? current
          : { left, top, width: nextWidth, height: nextHeight },
      );
    };
    setPreviewPlayerVisible(false);
    syncBounds();
    let frame = window.requestAnimationFrame(() => {
      setPreviewPlayerVisible(true);
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
      if (moved) resumePictureVideo();
    };
    startMouseDrag({
      onMove,
      onEnd: onUp,
      onCancel: () => {
        pictureDragRef.current = null;
        suppressPictureClickRef.current = true;
      },
    });
  };

  const onPictureClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!suppressPictureClickRef.current) {
      setPictureInPicture(false);
      resumePictureVideo();
    }
    suppressPictureClickRef.current = false;
  };

  const onHandleDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startPosition = portrait ? e.clientY : e.clientX;
    // 用轨道展开时的画面高度作为基准，避免把收起轨道腾出的空间记进偏好。
    const startSize = portrait ? contentHeight - measuredTrackHeight : modalWidth;
    const previousSize = portrait ? portraitHeight : landscapeWidth;
    const maxSize = portrait
      ? Math.min(
          availableWidth / layoutRatio,
          Math.max(0, baseVideoHeight - measuredTrackHeight),
        )
      : Math.min(MAX_WIDTH, maxModalWidth);
    const minSize = Math.min(startSize, portrait ? MIN_VIDEO_HEIGHT : MIN_WIDTH);
    // 居中弹窗的两侧同时伸缩，角点移动量约为尺寸变化的一半。
    const resizeScale = portrait || !hasSidePanel ? 2 : 1;
    let latestSize = startSize;

    const onMove = (ev: MouseEvent) => {
      const delta = (portrait ? ev.clientY : ev.clientX) - startPosition;
      const size = Math.min(
        Math.max(startSize, maxSize),
        Math.max(minSize, startSize + delta * resizeScale),
      );
      if (size === latestSize) return;
      latestSize = size;
      queuePreviewResize({
        portrait,
        value: size === startSize ? previousSize : size,
      });
    };
    const onUp = (ev: MouseEvent) => {
      onMove(ev);
      cancelResizeFrame();
      // 释放鼠标时立刻提交尚未等到下一帧的末尾位置。
      commitPendingResize();
      if (latestSize !== startSize && latestSize > 0) {
        writePref(portrait ? PORTRAIT_HEIGHT_KEY : LANDSCAPE_WIDTH_KEY, latestSize);
      }
    };
    startMouseDrag({
      onMove,
      onEnd: onUp,
      onCancel: () => {
        cancelResizeFrame();
        pendingResizeRef.current = null;
        if (portrait) setPortraitHeight(previousSize);
        else setLandscapeWidth(previousSize);
      },
    });
  };

  return {
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
  };
}
