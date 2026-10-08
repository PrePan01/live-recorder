import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { Button, Input, Modal, Popconfirm, Tooltip } from "antd";
import {
  CaretUpOutlined,
  DeleteOutlined,
  ForwardOutlined,
  PlusOutlined,
  PushpinOutlined,
  ScissorOutlined,
} from "@ant-design/icons";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import { recordingGapText } from "../utils/recordingGapText";

import {
  GENERIC_GAP_REASON,
  recordingGapKindText,
} from "../utils/recordingGapKindText";
import {
  timelinePercent,
  timelineSecondAt,
  rangeAtSecond,
  previewPosition,
  recordingTimelineEnd,
  recordingSeekTarget,
  type RecordingTrackMode,
} from "../utils/recordingTimeline";

type Props = {
  elapsedSeconds: number;
  /** 文件回放使用真实时长，选区调整不跳播。 */
  mode?: RecordingTrackMode;
  seekDisabled?: boolean;
  toolbar?: ReactNode;
  markerNavigationRef?: Ref<HTMLSpanElement>;
  /** 标记列表随时间轴共同展开和收起。 */
  children?: ReactNode;
  markers: RecordingMarker[];
  editable?: boolean;
  busy?: boolean;
  onAdd?: (text: string) => Promise<void>;
  onQuickAdd?: () => void;
  addingMarker?: boolean;
  quickAddDisabled?: boolean;
  onEdit?: (id: string, text: string) => Promise<void>;
  onMove?: (id: string, positionSeconds: number) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onExport?: (start: number, end: number) => void | Promise<void>;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSeekIntent?: (second: number) => void;
  onSeekCommit?: (target: number | "live", indicatorSecond?: number) => void;
  onReturnToLive?: () => void;
  previewMode?: "live" | "history";
  previewSecond?: number;
  previewLoading?: boolean;
  seekHint?: string;
  /** 中断缺口（缺口标记层）：positionMs=拼接位、尾缺=片尾处；无位缺口不画（不伪造位置）。 */
  gaps?: RecordingGap[];
};
type Drag =
  { kind: "start" | "end" | "playhead" } | { markerId: string } | null;
// 展开/收起全局记忆一个状态（不区分直播间）；脏值/存储不可用一律展开兑底。
const TRACK_COLLAPSED_KEY = "lr-recording-track-collapsed";
function readTrackCollapsed(): boolean {
  try {
    return window.localStorage.getItem(TRACK_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
function persistTrackCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(TRACK_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    /* 存储不可用静默，行为退化为本次会话内记忆 */
  }
}
const clock = (value: number) => {
  const seconds = Math.max(0, Math.floor(value));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

export default function RecordingTrack({
  elapsedSeconds,
  mode = "recording",
  seekDisabled = false,
  toolbar,
  markerNavigationRef,
  children,
  markers,
  editable = false,
  busy = false,
  onAdd,
  onQuickAdd,
  addingMarker = false,
  quickAddDisabled = false,
  onEdit,
  onMove,
  onDelete,
  onExport,
  onCollapsedChange,
  onSeekIntent,
  onSeekCommit,
  onReturnToLive,
  previewMode,
  previewSecond,
  previewLoading = false,
  seekHint,
  gaps = [],
}: Props) {
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
  const [collapsed, setCollapsed] = useState(readTrackCollapsed);
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
      else await onAdd?.(text);
    } catch {
      // 宿主展示保存错误，保留草稿以便重试。
      return;
    }
    setDraft("");
    setEditing(null);
    setEditorOpen(false);
  };
  const openEdit = (marker?: RecordingMarker) => {
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
    persistTrackCollapsed(next);
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

  const handle = (kind: "start" | "end", value: number) => (
    <div
      className={`lr-recording-track__handle lr-recording-track__handle--${kind}`}
      style={{ left: `${pct(value)}%` }}
      role="slider"
      tabIndex={0}
      aria-label={`选区${kind === "start" ? "起始" : "结束"}手柄`}
      aria-valuemin={0}
      aria-valuemax={recordingEnd}
      aria-valuenow={value}
      aria-valuetext={clock(value)}
      onPointerDown={(event) => beginRange(kind, event)}
      onKeyDown={(event) => onHandleKeyDown(kind, event)}
    >
      <span
        ref={(node) => {
          labelRefs.current[kind] = node;
        }}
        className={`lr-recording-track__handle-time ${timeLabelClass(value)}`}
        style={timeLabelStyle(kind)}
      >
        {clock(value)}
      </span>
      <span className="lr-recording-track__handle-shape" />
    </div>
  );

  return (
    <section
      className={`lr-recording-track${collapsed ? " lr-recording-track--collapsed" : ""}`}
      aria-label={mode === "playback" ? "回放轨道" : "录制轨道"}
    >
      <div className="lr-recording-track__topline">
        <div className="lr-recording-track__status-group">
          <Button
            size="small"
            className="lr-recording-track__toggle"
            aria-label={collapsed ? "展开时间轴与标记" : "收起时间轴与标记"}
            aria-expanded={!collapsed}
            icon={<CaretUpOutlined />}
            onClick={toggleCollapsed}
          />
          {seekHint ? (
            <span className="lr-recording-track__hint">{seekHint}</span>
          ) : null}
        </div>
        {toolbar && (
          <div className="lr-recording-track__toolbar">{toolbar}</div>
        )}
        {editable && (
          <span className="lr-recording-track__actions">
            {onReturnToLive && (
              <Button
                size="small"
                icon={<ForwardOutlined />}
                onClick={onReturnToLive}
              >
                直播
              </Button>
            )}
            {markers.length > 0 && markerNavigationRef && (
              <span
                className="lr-recording-track__marker-navigation"
                ref={markerNavigationRef}
              />
            )}
            {onQuickAdd && (
              <Tooltip title="一键标记当前位置（Alt+M）">
                <Button
                  size="small"
                  icon={<PushpinOutlined />}
                  loading={addingMarker}
                  disabled={quickAddDisabled}
                  onClick={onQuickAdd}
                >
                  标记
                </Button>
              </Tooltip>
            )}
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => openEdit()}
            >
              标签
            </Button>
            <Button
              type="primary"
              size="small"
              className="lr-recording-track__export"
              icon={<ScissorOutlined />}
              disabled={selectionSeconds < 1 || busy}
              loading={busy}
              onClick={() => void onExport?.(range[0], range[1])}
            >
              导出选区
            </Button>
          </span>
        )}
      </div>
      <div
        className="lr-recording-track__body"
        aria-hidden={collapsed}
        inert={collapsed}
      >
        <div className="lr-recording-track__body-inner">
          <div className="lr-recording-track__canvas-wrap">
            <div className="lr-recording-track__canvas">
              <div
                className="lr-recording-track__rail"
                ref={railRef}
                onPointerDown={railJump}
              >
                <div
                  className="lr-recording-track__recorded"
                  style={{ width: `${pct(recordingEnd)}%` }}
                />
                {gaps.map((gap) => {
                  if (gap.positionMs == null) return null;
                  const posSec = gap.positionMs / 1000;
                  const atTail = posSec >= recordingEnd - 1;
                  const secs = Math.round(gap.missingMs / 1000);
                  return (
                    <Tooltip
                      key={gap.id}
                      title={
                        <div style={{ fontSize: 12 }}>
                          <div>
                            {gap.estimated ? "约 " : ""}缺失 {secs} 秒
                          </div>
                          <div style={{ opacity: 0.8 }}>
                            发生于 {new Date(gap.startedAt).toLocaleString()}
                          </div>
                          <div style={{ opacity: 0.8 }}>
                            {recordingGapText(gap).reason === GENERIC_GAP_REASON
                              ? recordingGapKindText(gap.kind)
                              : recordingGapText(gap).reason}
                          </div>
                        </div>
                      }
                    >
                      <div
                        className={`lr-recording-track__gap${atTail ? " lr-recording-track__gap--tail" : ""}`}
                        style={{ left: `${pct(Math.max(0, posSec))}%` }}
                      />
                    </Tooltip>
                  );
                })}
                {showSelection && (
                  <div
                    className={`lr-recording-track__selection${startPosition === 0 ? " lr-recording-track__selection--at-start" : ""}${endPosition === 100 ? " lr-recording-track__selection--at-end" : ""}`}
                    style={{
                      left: `${startPosition}%`,
                      width: `${Math.max(0, endPosition - startPosition)}%`,
                    }}
                  />
                )}
                {previewMode && positionSecond != null && (
                  <div
                    className={`lr-recording-track__playhead lr-recording-track__playhead--${previewMode}${dragging && "kind" in dragging && dragging.kind === "playhead" ? " lr-recording-track__playhead--dragging" : ""}`}
                    style={{
                      left: `${pct(positionSecond)}%`,
                    }}
                    aria-label={
                      previewMode === "live"
                        ? "直播位置"
                        : `回看位置 ${clock(Math.floor(positionSecond))}`
                    }
                    role="slider"
                    tabIndex={seekDisabled ? -1 : 0}
                    aria-disabled={seekDisabled}
                    aria-valuemin={0}
                    aria-valuemax={recordingEnd}
                    aria-valuenow={positionSecond}
                    aria-valuetext={clock(Math.floor(positionSecond))}
                    onPointerDown={beginPlayhead}
                    onKeyDown={(event) => {
                      const direction =
                        event.key === "ArrowLeft" || event.key === "ArrowDown"
                          ? -1
                          : event.key === "ArrowRight" ||
                              event.key === "ArrowUp"
                            ? 1
                            : 0;
                      if (!direction || seekDisabled) return;
                      event.preventDefault();
                      const second = Math.max(
                        0,
                        Math.min(
                          recordingEnd,
                          positionSecond + direction * (event.shiftKey ? 5 : 1),
                        ),
                      );
                      onSeekIntent?.(second);
                      const target = recordingSeekTarget(
                        mode,
                        "playhead",
                        second,
                        recordingEnd,
                        seekDisabled,
                      );
                      if (target !== undefined) onSeekCommit?.(target);
                    }}
                  />
                )}
                {showSelection && handle("start", range[0])}
                {showSelection && handle("end", range[1])}
              </div>
              {dragging && (
                <i
                  className="lr-recording-track__guide"
                  style={{
                    left: `${pct("kind" in dragging ? (dragging.kind === "playhead" ? (positionSecond ?? 0) : range[dragging.kind === "start" ? 0 : 1]) : (markerPositions[dragging.markerId] ?? 0))}%`,
                  }}
                />
              )}
              <div className="lr-recording-track__labels">
                <span>{clock(0)}</span>
                <span>{clock(Math.floor(timelineEnd))}</span>
              </div>
              {markers.length > 0 && (
                <div className="lr-recording-track__markers">
                  {markers.map((marker, index) => {
                    const position =
                      markerPositions[marker.id] ?? marker.positionSeconds;
                    return (
                      <Tooltip
                        key={marker.id}
                        title={`${clock(position)}：${marker.text}${editable ? "（单击回看，双击编辑）" : ""}`}
                      >
                        <button
                          aria-label={`${clock(position)} · ${marker.text}`}
                          className={`lr-recording-track__marker lr-recording-track__marker--${index % 3}`}
                          style={{ left: `${pct(position)}%` }}
                          onPointerDown={(event) => beginMarker(marker, event)}
                          onClick={(event) => {
                            if (
                              (event.detail > 0 && movedRef.current) ||
                              seekDisabled
                            )
                              return;
                            if (markerClickTimer.current)
                              clearTimeout(markerClickTimer.current);
                            if (editable && event.detail > 0) {
                              markerClickTimer.current = setTimeout(() => {
                                markerClickTimer.current = null;
                                onSeekCommit?.(Math.floor(position));
                              }, 500);
                            } else onSeekCommit?.(Math.floor(position));
                          }}
                          onDoubleClick={() => {
                            if (markerClickTimer.current)
                              clearTimeout(markerClickTimer.current);
                            markerClickTimer.current = null;
                            if (editable && !movedRef.current) openEdit(marker);
                          }}
                        >
                          {marker.text}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="lr-recording-track__summary">
            {showSelection && (
              <span className="lr-recording-track__range-summary">
                <i aria-hidden="true" />
                选区{" "}
                <span>
                  {clock(range[0])} — {clock(range[1])}
                </span>
              </span>
            )}
            {previewMode && (
              <span
                className={`lr-recording-track__preview-legend lr-recording-track__preview-legend--${previewMode}`}
              >
                <i aria-hidden="true" />{" "}
                {mode === "playback" ? "播放位置" : "预览位置"}
              </span>
            )}
            <span className="lr-recording-track__duration">
              {previewLoading
                ? "加载中..."
                : previewMode === "live"
                  ? "直播中"
                  : `回看${previewSecond != null ? ` ${clock(Math.floor(previewSecond))}` : ""}`}
            </span>
          </div>
          {children}
        </div>
      </div>
      <Modal
        title={editing ? "编辑标记" : "添加标记"}
        open={editorOpen}
        onOk={() => void submit()}
        onCancel={() => {
          setDraft("");
          setEditing(null);
          setEditorOpen(false);
        }}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          autoFocus
          maxLength={200}
          placeholder="输入标记文字"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={() => void submit()}
        />
        {editing && (
          <Popconfirm
            title="删除这条标记？"
            onConfirm={() =>
              void onDelete?.(editing.id).then(() => {
                setDraft("");
                setEditing(null);
                setEditorOpen(false);
              })
            }
          >
            <Button danger icon={<DeleteOutlined />} style={{ marginTop: 12 }}>
              删除标记
            </Button>
          </Popconfirm>
        )}
      </Modal>
    </section>
  );
}
