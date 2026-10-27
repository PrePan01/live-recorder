import { App } from "antd";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { RecordingMarker } from "../../types/recording";

import {
  previewPosition,
  rangeAtSecond,
  recordingSeekTarget,
  recordingTimelineEnd,
  timelinePercent,
  timelineSecondAt,
} from "../../utils/timeline/recordingTimeline";

import type { RecordingTrackProps } from "./types";
import { useLocalPref } from "../../hooks/useLocalPref";
import type { PrefCodec } from "../../utils/prefStorage";
type Drag =
  | { kind: "start" | "end" | "playhead"; pointerOffset?: number }
  | {
      markerId: string;
      start: number;
      pointerStart: number;
      duration?: number;
    }
  | null;
const TRACK_COLLAPSED_KEY = "lr-recording-track-collapsed";
const trackCollapsedCodec: PrefCodec<boolean> = {
  read: (raw) => raw === "1",
  write: (value) => (value ? "1" : "0"),
};
export function useRecordingTrack({
  elapsedSeconds,
  mode = "recording",
  seekDisabled = false,
  markers,
  editable = false,
  rangeSelection,
  onExport,
  selectionDisabled = false,
  onSelectionChange,
  markerPositionSecond,
  getMarkerPosition,
  onAdd,
  onEdit,
  onMove,
  onCollapsedChange,
  onSeekIntent,
  onSeekCommit,
  previewMode,
  previewSecond,
  previewLoading = false,
}: RecordingTrackProps) {
  const { message } = App.useApp();
  const [range, setRange] = useState<[number, number]>(() => [
    0,
    elapsedSeconds,
  ]);
  const wasRangeEditing = useRef(false);
  const [dragging, setDragging] = useState<Drag>(null);
  const [playheadSecond, setPlayheadSecond] = useState<number | null>(null);
  const [markerPositions, setMarkerPositions] = useState<
    Record<string, number>
  >({});
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const addPositionRef = useRef(0);
  const submitLock = useRef(false);
  const [collapsed, setCollapsed] = useLocalPref<boolean>(
    TRACK_COLLAPSED_KEY,
    false,
    trackCollapsedCodec,
  );
  const movedRef = useRef(false);
  const markerClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (markerClickTimer.current) clearTimeout(markerClickTimer.current);
      markerClickTimer.current = null;
    },
    [markers],
  );
  const touchedRef = useRef(false);
  const lastElapsedRef = useRef(elapsedSeconds);
  const rangeRef = useRef(range);
  useEffect(() => {
    rangeRef.current = range;
  });
  const railRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<Record<"start" | "end", HTMLSpanElement | null>>({
    start: null,
    end: null,
  });
  const [labelMetrics, setLabelMetrics] = useState({
    railWidth: 0,
    start: 0,
    end: 0,
  });
  const recordingEnd = elapsedSeconds;
  const timelineEnd = recordingTimelineEnd(recordingEnd, mode);
  const showSelection =
    rangeSelection != null || (!!onExport && !selectionDisabled);
  useLayoutEffect(() => {
    onSelectionChange?.(
      !rangeSelection &&
        dragging != null &&
        "kind" in dragging &&
        dragging.kind !== "playhead",
    );
    return () => onSelectionChange?.(false);
  }, [dragging, rangeSelection, onSelectionChange]);
  useEffect(() => {
    if (rangeSelection) {
      touchedRef.current = true;
      setRange(rangeSelection);
    }
  }, [rangeSelection]);

  useLayoutEffect(() => {
    if (rangeSelection) {
      wasRangeEditing.current = true;
      return;
    }
    if (wasRangeEditing.current) {
      wasRangeEditing.current = false;
      touchedRef.current = false;
      rangeRef.current = [0, recordingEnd];
      setRange([0, recordingEnd]);
    }
    const previousEnd = lastElapsedRef.current;
    lastElapsedRef.current = recordingEnd;
    setRange(([start, end]) => {
      // 未手动调整时，选区始终覆盖全部已录制内容；调整后保留最后一次形成的区间长度。
      if (!touchedRef.current) return [0, recordingEnd];
      if (recordingEnd === 0) return [0, 0];
      const safeStart = Math.max(0, Math.min(start, recordingEnd - 1));
      // 末手柄贴住右端 = 用户要「跟到最新」：随录制增长继续跟进；
      // 否则视为选中固定区间，保持长度不动。
      const followTail = end >= previousEnd;
      const safeEnd = followTail
        ? recordingEnd
        : Math.min(recordingEnd, Math.max(safeStart + 1, end));
      return [safeStart, safeEnd];
    });
  }, [elapsedSeconds, recordingEnd, rangeSelection, onSelectionChange]);

  const pct = (value: number) => timelinePercent(value, timelineEnd);
  // 直播指示器跟随已录尾部；保存标记时独立读取点击瞬间的媒体位置。
  const positionSecond =
    playheadSecond ??
    previewPosition(previewMode, recordingEnd, previewSecond, previewLoading);
  useLayoutEffect(() => {
    const update = () => {
      const next = {
        railWidth: railRef.current?.clientWidth ?? 0,
        start: labelRefs.current.start?.offsetWidth ?? 0,
        end: labelRefs.current.end?.offsetWidth ?? 0,
      };
      setLabelMetrics((current) =>
        current.railWidth === next.railWidth &&
        current.start === next.start &&
        current.end === next.end
          ? current
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (railRef.current) observer.observe(railRef.current);
    if (labelRefs.current.start) observer.observe(labelRefs.current.start);
    if (labelRefs.current.end) observer.observe(labelRefs.current.end);
    return () => observer.disconnect();
  }, []);
  const positionAt = useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      if (!rail || recordingEnd <= 0) return 0;
      const rect = rail.getBoundingClientRect();
      const scale = rail.offsetWidth > 0 ? rect.width / rail.offsetWidth : 1;
      return timelineSecondAt(
        clientX,
        rect.left + rail.clientLeft * scale,
        rail.clientWidth * scale,
        timelineEnd,
        recordingEnd,
      );
    },
    [recordingEnd, timelineEnd],
  );
  const setRangeAt = useCallback(
    (kind: "start" | "end", clientX: number, pointerOffset = 0) => {
      const value = positionAt(clientX) - pointerOffset;
      const next = rangeAtSecond(rangeRef.current, kind, value, recordingEnd);
      rangeRef.current = next;
      setRange(next);
      return next[kind === "start" ? 0 : 1];
    },
    [positionAt, recordingEnd],
  );

  useEffect(() => {
    if (!dragging) return;
    let frame: number | null = null;
    let latestX = 0;
    const markerPositionAt = (clientX: number) => {
      if ("kind" in dragging) return 0;
      if (dragging.duration == null) return positionAt(clientX);
      return Math.max(
        0,
        Math.min(
          recordingEnd - dragging.duration,
          dragging.start + positionAt(clientX) - dragging.pointerStart,
        ),
      );
    };
    const paint = () => {
      frame = null;
      if ("kind" in dragging) {
        if (dragging.kind === "playhead")
          setPlayheadSecond(
            Math.max(
              0,
              Math.min(
                recordingEnd,
                positionAt(latestX) - (dragging.pointerOffset ?? 0),
              ),
            ),
          );
        else setRangeAt(dragging.kind, latestX, dragging.pointerOffset);
      } else
        setMarkerPositions((current) => ({
          ...current,
          [dragging.markerId]: markerPositionAt(latestX),
        }));
    };
    const cancelFrame = () => {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
    };
    const move = (event: PointerEvent) => {
      movedRef.current = true;
      latestX = event.clientX;
      if (frame == null) frame = requestAnimationFrame(paint);
    };
    const up = (event: PointerEvent) => {
      cancelFrame();
      // 手柄或播放指示器松手时提交跳播；贴录制末尾则切回直播。
      if (dragging && "kind" in dragging) {
        // 起播真值按「钳制生效位」提交（左柄不过 end-1、右柄贴右端=回直播），
        // 不拿指针原始落点冒充。
        const clamped =
          dragging.kind === "playhead"
            ? Math.max(
                0,
                Math.min(
                  recordingEnd,
                  positionAt(event.clientX) - (dragging.pointerOffset ?? 0),
                ),
              )
            : setRangeAt(dragging.kind, event.clientX, dragging.pointerOffset);
        const target = recordingSeekTarget(
          mode,
          dragging.kind,
          clamped,
          recordingEnd,
          seekDisabled,
        );
        if (
          target !== undefined &&
          (!rangeSelection || dragging.kind === "playhead")
        )
          onSeekCommit?.(
            target,
            dragging.kind === "playhead" ? clamped : undefined,
          );
        setPlayheadSecond(null);
      }
      if (dragging && !("kind" in dragging)) {
        const position = markerPositionAt(event.clientX);
        if (movedRef.current)
          void onMove?.(
            dragging.markerId,
            position,
            dragging.duration == null
              ? undefined
              : position + dragging.duration,
          )
            .catch(() => undefined)
            .finally(() =>
              setMarkerPositions((current) => {
                const next = { ...current };
                delete next[dragging.markerId];
                return next;
              }),
            );
        else
          setMarkerPositions((current) => {
            const next = { ...current };
            delete next[dragging.markerId];
            return next;
          });
      }
      setDragging(null);
    };
    const cancel = () => {
      cancelFrame();
      if (!("kind" in dragging)) {
        setMarkerPositions((current) => {
          const next = { ...current };
          delete next[dragging.markerId];
          return next;
        });
      }
      setPlayheadSecond(null);
      setDragging(null);
    };
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      cancelFrame();
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [
    dragging,
    onMove,
    positionAt,
    setRangeAt,
    onSeekCommit,
    recordingEnd,
    mode,
    rangeSelection,
    seekDisabled,
  ]);

  const beginRange = (kind: "start" | "end", event: React.PointerEvent) => {
    if (recordingEnd <= 0 || (selectionDisabled && !rangeSelection)) return;
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    touchedRef.current = true;
    const second = rangeRef.current[kind === "start" ? 0 : 1];
    if (!rangeSelection && mode === "recording") onSeekIntent?.(second);
    setDragging({ kind, pointerOffset: positionAt(event.clientX) - second });
  };
  const beginPlayhead = (event: React.PointerEvent, keepPosition = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (seekDisabled || recordingEnd <= 0) return;
    movedRef.current = false;
    const pointerSecond = positionAt(event.clientX);
    const second = keepPosition
      ? (positionSecond ?? pointerSecond)
      : pointerSecond;
    setPlayheadSecond(second);
    onSeekIntent?.(second);
    setDragging({ kind: "playhead", pointerOffset: pointerSecond - second });
  };
  const beginMarker = (marker: RecordingMarker, event: React.PointerEvent) => {
    if (markerClickTimer.current) clearTimeout(markerClickTimer.current);
    markerClickTimer.current = null;
    // 标记拖动独立于轨道选区；片段保留按下位置，整体平移。
    event.stopPropagation();
    movedRef.current = false;
    if (!editable || !onMove || recordingEnd <= 0) return;
    event.preventDefault();
    setMarkerPositions((current) => ({
      ...current,
      [marker.id]: marker.positionSeconds,
    }));
    setDragging({
      markerId: marker.id,
      start: marker.positionSeconds,
      pointerStart: positionAt(event.clientX),
      duration:
        marker.endPositionSeconds == null
          ? undefined
          : marker.endPositionSeconds - marker.positionSeconds,
    });
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text || submitLock.current) return;
    submitLock.current = true;
    try {
      if (editing) await onEdit?.(editing.id, text);
      else await onAdd?.(text, addPositionRef.current);
    } catch {
      // 宿主展示保存错误，保留草稿以便重试。
      return;
    } finally {
      submitLock.current = false;
    }
    setDraft("");
    setEditing(null);
    setEditorOpen(false);
  };
  const openEdit = async (marker?: RecordingMarker) => {
    if (submitLock.current) return;
    // 锁定打开标签编辑器时的位置，输入文字和保存期间时间轴仍会推进。
    if (!marker) {
      try {
        addPositionRef.current = getMarkerPosition
          ? await getMarkerPosition()
          : Math.max(
              0,
              Math.floor(markerPositionSecond ?? positionSecond ?? 0),
            );
      } catch {
        message.error("播放位置尚未就绪，请稍后重试");
        return;
      }
    }
    setEditing(marker ?? null);
    setDraft(marker?.text ?? "");
    setEditorOpen(true);
  };
  const railJump = (event: React.PointerEvent) => {
    if (mode === "playback" || !rangeSelection) {
      beginPlayhead(event);
      return;
    }
    touchedRef.current = true;
    const point = positionAt(event.clientX);
    setRangeAt(
      Math.abs(point - range[0]) <= Math.abs(point - range[1])
        ? "start"
        : "end",
      event.clientX,
    );
  };
  const nudgeRange = (kind: "start" | "end", delta: number) => {
    if (recordingEnd <= 0 || (selectionDisabled && !rangeSelection)) return;
    touchedRef.current = true;
    setRange(([start, end]) =>
      kind === "start"
        ? [Math.max(0, Math.min(start + delta, end - 1)), end]
        : [start, Math.min(recordingEnd, Math.max(start + 1, end + delta))],
    );
  };
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    onCollapsedChange?.(next);
  };
  const onHandleKeyDown = (
    kind: "start" | "end",
    event: React.KeyboardEvent,
  ) => {
    const step = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      nudgeRange(kind, -step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      nudgeRange(kind, step);
    }
  };
  const startPosition = pct(range[0]);
  const endPosition = pct(range[1]);
  const edgeGap = 4;
  const startLabelLeft =
    startPosition === 0
      ? 0
      : (labelMetrics.railWidth * startPosition) / 100 - labelMetrics.start / 2;
  const endLabelLeft =
    endPosition === 100
      ? labelMetrics.railWidth - labelMetrics.end
      : (labelMetrics.railWidth * endPosition) / 100 - labelMetrics.end / 2;
  let startLabelShift = 0;
  let endLabelShift = 0;
  if (
    labelMetrics.start &&
    labelMetrics.end &&
    startLabelLeft + labelMetrics.start + edgeGap > endLabelLeft
  ) {
    if (startPosition === 0 && endPosition !== 100) {
      // 左端标签固定，右侧拖来的标签刚触及它时停止继续左移。
      endLabelShift =
        startLabelLeft + labelMetrics.start + edgeGap - endLabelLeft;
    } else if (endPosition === 100 && startPosition !== 0) {
      // 右端标签固定，左侧拖来的标签刚触及它时停止继续右移。
      startLabelShift =
        endLabelLeft - edgeGap - labelMetrics.start - startLabelLeft;
    } else if (dragging && "kind" in dragging && dragging.kind === "start") {
      startLabelShift =
        endLabelLeft - edgeGap - labelMetrics.start - startLabelLeft;
    } else {
      endLabelShift =
        startLabelLeft + labelMetrics.start + edgeGap - endLabelLeft;
    }
  }
  // 靠近两端时将整段时间文字收进轨道，保留手柄本身的媒体位置。
  if (labelMetrics.railWidth > 0) {
    startLabelShift = Math.max(
      -startLabelLeft,
      Math.min(
        startLabelShift,
        labelMetrics.railWidth - labelMetrics.start - startLabelLeft,
      ),
    );
    endLabelShift = Math.max(
      -endLabelLeft,
      Math.min(
        endLabelShift,
        labelMetrics.railWidth - labelMetrics.end - endLabelLeft,
      ),
    );
  }
  const timeLabelClass = (value: number) => {
    const position = pct(value);
    return position === 0
      ? "lr-recording-track__handle-time--inset-start"
      : position === 100
        ? "lr-recording-track__handle-time--inset-end"
        : "";
  };
  const timeLabelStyle = (kind: "start" | "end"): CSSProperties =>
    ({
      "--lr-recording-track-label-shift": `${kind === "start" ? startLabelShift : endLabelShift}px`,
    }) as CSSProperties;
  const selectionSeconds = Math.max(0, range[1] - range[0]);

  return {
    range,
    dragging,
    markerPositions,
    draft,
    setDraft,
    editing,
    setEditing,
    editorOpen,
    setEditorOpen,
    collapsed,
    movedRef,
    markerClickTimer,
    railRef,
    labelRefs,
    recordingEnd,
    timelineEnd,
    showSelection,
    pct,
    positionSecond,
    beginRange,
    beginPlayhead,
    beginMarker,
    submit,
    openEdit,
    railJump,
    toggleCollapsed,
    onHandleKeyDown,
    nudgeRange,
    startPosition,
    endPosition,
    timeLabelClass,
    timeLabelStyle,
    selectionSeconds,
  };
}
