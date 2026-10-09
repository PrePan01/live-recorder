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
  fitPreviewBoxByHeight,
} from "../../utils/previewLayout";

const MIN_WIDTH = 640;
const MAX_WIDTH = 1440;
const PICTURE_IN_PICTURE_WIDTH = 360;
const MODAL_BODY_PADDING_X = 48;
const MODAL_VIEWPORT_GUTTER_X = 32;
const MODAL_CHROME_HEIGHT = 108;
const RECORDING_TRACK_MIN_WIDTH = 450;
const MIN_VIDEO_HEIGHT = 240;
type PlayerBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type PendingPreviewResize = { portrait: boolean; value: number };

export function usePreviewLayout(
  defaultWidth: number | undefined,
  displayedTrack: { id: string; startedAt: string } | null,
) {
  const startMouseDrag = useMouseDrag();
  // 普通观看默认占视口约 80%，同时为窄屏和超宽屏设置合理边界；直播墙全屏可传入显式宽度。
  const [width, setWidth] = useState(
    () =>
      defaultWidth ??
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.8)),
      ),
  );
  // 流的真实比例（宽/高）。元数据未就绪时播放器保持隐藏，避免先按 16:9 显示再缩成竖屏。
  const [streamRatio, setStreamRatio] = useState<number | null>(null);
  const [streamRatioReady, setStreamRatioReady] = useState(false);
  // 竖屏画面高度（宽度按比例算出）；null = 用满可视高度上限，用户拖拽后才取值。
  const [portraitHeight, setPortraitHeight] = useState<number | null>(null);
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
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<PendingPreviewResize | null>(null);

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
    };
    startMouseDrag({
      onMove,
      onEnd: onUp,
      onCancel: () => {
        dragRef.current = null;
        pendingResizeRef.current = null;
        if (resizeFrameRef.current !== null) {
          window.cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
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
  };
}
