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
} from "../../utils/recordingTimeline";

import type { RecordingTrackProps } from "./types";
import { useLocalPref } from "../../hooks/useLocalPref";
import type { PrefCodec } from "../../utils/prefStorage";
type Drag =
  { kind: "start" | "end" | "playhead" } | { markerId: string } | null;
// 展开/收起全局记忆一个状态（不区分直播间）；脏值/存储不可用一律展开兑底。
// 存储格式="1"/"0"（历史键，codec 保持原格式防丢用户已存选择）。
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
  const [range, setRange] = useState<[number, number]>(() => [
    0,
    elapsedSeconds,
  ]);
  const [dragging, setDragging] = useState<Drag>(null);
  const [playheadSecond, setPlayheadSecond] = useState<number | null>(null);
  const [markerPositions, setMarkerPositions] = useState<
    Record<string, number>
  >({});
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const addPositionRef = useRef(0);
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
  // 仅文件回放隐藏选区；录制中的历史预览仍保留剪辑选区。
  const showSelection = mode !== "playback";

  useLayoutEffect(() => {
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
  }, [elapsedSeconds, recordingEnd]);

  const pct = (value: number) => timelinePercent(value, timelineEnd);
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
    (kind: "start" | "end", clientX: number) => {
      const value = positionAt(clientX);
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
    const paint = () => {
      frame = null;
      if ("kind" in dragging) {
        if (dragging.kind === "playhead")
          setPlayheadSecond(positionAt(latestX));
        else setRangeAt(dragging.kind, latestX);
      } else
        setMarkerPositions((current) => ({
          ...current,
          [dragging.markerId]: positionAt(latestX),
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
            ? positionAt(event.clientX)
            : setRangeAt(dragging.kind, event.clientX);
        const target = recordingSeekTarget(
          mode,
          dragging.kind,
          clamped,
          recordingEnd,
          seekDisabled,
        );
        if (target !== undefined)
          onSeekCommit?.(
            target,
            dragging.kind === "playhead" ? clamped : undefined,
          );
        setPlayheadSecond(null);
      }
      if (dragging && !("kind" in dragging)) {
        const position = positionAt(event.clientX);
        if (movedRef.current)
          void onMove?.(dragging.markerId, position)
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
    seekDisabled,
  ]);

  const beginRange = (kind: "start" | "end", event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    touchedRef.current = true;
    if (mode === "recording") onSeekIntent?.(positionAt(event.clientX));
    setDragging({ kind });
  };
  const beginPlayhead = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (seekDisabled || recordingEnd <= 0) return;
    movedRef.current = false;
    const second = positionAt(event.clientX);
    setPlayheadSecond(second);
    onSeekIntent?.(second);
    setDragging({ kind: "playhead" });
  };
  const beginMarker = (marker: RecordingMarker, event: React.PointerEvent) => {
    if (markerClickTimer.current) clearTimeout(markerClickTimer.current);
    markerClickTimer.current = null;
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    setMarkerPositions((current) => ({
      ...current,
      [marker.id]: marker.positionSeconds,
    }));
    setDragging({ markerId: marker.id });
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      if (editing) await onEdit?.(editing.id, text);
      else await onAdd?.(text, addPositionRef.current);
    } catch {
      // 宿主展示保存错误，保留草稿以便重试。
      return;
    }
    setDraft("");
    setEditing(null);
    setEditorOpen(false);
  };
  const openEdit = (marker?: RecordingMarker) => {
    // 锁定打开标签编辑器时的位置，输入文字和保存期间时间轴仍会推进。
    if (!marker) {
      addPositionRef.current = Math.max(0, Math.floor(positionSecond ?? 0));
    }
    setEditing(marker ?? null);
    setDraft(marker?.text ?? "");
    setEditorOpen(true);
  };
  const railJump = (event: React.PointerEvent) => {
    if (mode === "playback") {
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
      ? -7
      : (labelMetrics.railWidth * startPosition) / 100 - labelMetrics.start / 2;
  const endLabelLeft =
    endPosition === 100
      ? labelMetrics.railWidth + 7 - labelMetrics.end
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
    startPosition,
    endPosition,
    timeLabelClass,
    timeLabelStyle,
    selectionSeconds,
  };
}
