import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button, Input, Modal, Popconfirm, Tooltip } from "antd";
import {
  CaretUpOutlined,
  DeleteOutlined,
  ForwardOutlined,
  PlusOutlined,
  ScissorOutlined,
} from "@ant-design/icons";
import type { RecordingMarker } from "../types/recording";
import {
  timelinePercent,
  timelineSecondAt,
  rangeAtSecond,
  previewPosition,
} from "../utils/recordingTimeline";

type Props = {
  elapsedSeconds: number;
  markers: RecordingMarker[];
  editable?: boolean;
  busy?: boolean;
  onAdd?: (text: string) => Promise<void>;
  onEdit?: (id: string, text: string) => Promise<void>;
  onMove?: (id: string, positionSeconds: number) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onExport?: (start: number, end: number) => void | Promise<void>;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSeekIntent?: (second: number) => void;
  onSeekCommit?: (target: number | "live") => void;
  onReturnToLive?: () => void;
  previewMode?: "live" | "history";
  previewSecond?: number;
  seekHint?: string;
};
type Drag = { kind: "start" | "end" } | { markerId: string } | null;
// 仅调整这个值即可同时改变初始显示上限与每次扩展的阶梯大小。
const TIMELINE_STEP_SECONDS = 60;
const clock = (value: number) => {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

export default function RecordingTrack({
  elapsedSeconds,
  markers,
  editable = false,
  busy = false,
  onAdd,
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
  seekHint,
}: Props) {
  const [range, setRange] = useState<[number, number]>(() => [
    0,
    elapsedSeconds,
  ]);
  const [dragging, setDragging] = useState<Drag>(null);
  const [markerPositions, setMarkerPositions] = useState<
    Record<string, number>
  >({});
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const movedRef = useRef(false);
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
  const liveTimelineEnd = Math.max(
    TIMELINE_STEP_SECONDS,
    Math.ceil(Math.max(1, recordingEnd) / TIMELINE_STEP_SECONDS) *
      TIMELINE_STEP_SECONDS,
  );
  // 时间轴始终按已录制时长跨档扩展；手动选择只固定选区，不冻结显示上限。
  const timelineEnd = liveTimelineEnd;

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
  const positionSecond = previewPosition(
    previewMode,
    recordingEnd,
    previewSecond,
  );
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
  }, [elapsedSeconds, range]);
  const positionAt = useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      if (!rail || recordingEnd < 1) return 0;
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
    const move = (event: PointerEvent) => {
      movedRef.current = true;
      if ("kind" in dragging) setRangeAt(dragging.kind, event.clientX);
      else
        setMarkerPositions((current) => ({
          ...current,
          [dragging.markerId]: positionAt(event.clientX),
        }));
    };
    const up = (event: PointerEvent) => {
      // 末手柄松手=跳播提交：贴右端 = 切回实时直播，否则从松手位置起播。
      if (dragging && "kind" in dragging) {
        // 起播真值按「钳制生效位」提交（左柄不过 end-1、右柄贴右端=回直播），
        // 不拿指针原始落点冒充。
        const clamped = setRangeAt(dragging.kind, event.clientX);
        onSeekCommit?.(clamped >= recordingEnd ? "live" : clamped);
      }
      if (dragging && !("kind" in dragging)) {
        const position = markerPositions[dragging.markerId];
        if (movedRef.current && position !== undefined)
          void onMove?.(dragging.markerId, position).finally(() =>
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
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [
    dragging,
    markerPositions,
    onMove,
    positionAt,
    setRangeAt,
    onSeekCommit,
    recordingEnd,
  ]);

  const beginRange = (kind: "start" | "end", event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    movedRef.current = false;
    touchedRef.current = true;
    onSeekIntent?.(positionAt(event.clientX));
    setDragging({ kind });
  };
  const beginMarker = (marker: RecordingMarker, event: React.PointerEvent) => {
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
    if (editing) await onEdit?.(editing.id, text);
    else await onAdd?.(text);
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
  const toggleCollapsed = () =>
    setCollapsed((current) => {
      const next = !current;
      onCollapsedChange?.(next);
      return next;
    });
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
      aria-label="录制轨道"
    >
      <div className="lr-recording-track__topline">
        <div className="lr-recording-track__status-group">
          <Button
            size="small"
            className="lr-recording-track__toggle"
            aria-label={collapsed ? "展开轨道" : "收缩轨道"}
            aria-expanded={!collapsed}
            icon={<CaretUpOutlined />}
            onClick={toggleCollapsed}
          />
          {seekHint && (!previewMode || previewSecond == null) ? (
            <span className="lr-recording-track__hint">{seekHint}</span>
          ) : null}
        </div>
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
            <div
              className={`lr-recording-track__selection${startPosition === 0 ? " lr-recording-track__selection--at-start" : ""}${endPosition === 100 ? " lr-recording-track__selection--at-end" : ""}`}
              style={{
                left: `${startPosition}%`,
                width: `${Math.max(0, endPosition - startPosition)}%`,
              }}
            />
            {previewMode && positionSecond != null && (
              <div
                className={`lr-recording-track__playhead lr-recording-track__playhead--${previewMode}`}
                style={{
                  left: `${pct(positionSecond)}%`,
                }}
                aria-label={
                  previewMode === "live"
                    ? "直播位置"
                    : `回看位置 ${clock(Math.floor(positionSecond))}`
                }
              />
            )}
            {handle("start", range[0])}
            {handle("end", range[1])}
          </div>
          {dragging && (
            <i
              className="lr-recording-track__guide"
              style={{
                left: `${pct("kind" in dragging ? range[dragging.kind === "start" ? 0 : 1] : (markerPositions[dragging.markerId] ?? 0))}%`,
              }}
            />
          )}
          <div className="lr-recording-track__labels">
            <span>{clock(0)}</span>
            <span>{clock(timelineEnd)}</span>
          </div>
          {markers.length > 0 && (
            <div className="lr-recording-track__markers">
              {markers.map((marker, index) => {
                const position =
                  markerPositions[marker.id] ?? marker.positionSeconds;
                return (
                  <Tooltip
                    key={marker.id}
                    title={`${clock(position)} · ${marker.text}`}
                  >
                    <button
                      aria-label={`${clock(position)} · ${marker.text}`}
                      className={`lr-recording-track__marker lr-recording-track__marker--${index % 3}`}
                      style={{ left: `${pct(position)}%` }}
                      onPointerDown={(event) => beginMarker(marker, event)}
                      onClick={() => {
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
        <span className="lr-recording-track__range-summary">
          <i aria-hidden="true" />
          选区{" "}
          <span>
            {clock(range[0])} — {clock(range[1])}
          </span>
        </span>
        {previewMode && (
          <span
            className={`lr-recording-track__preview-legend lr-recording-track__preview-legend--${previewMode}`}
          >
            <i aria-hidden="true" /> 预览位置
          </span>
        )}
        <span className="lr-recording-track__duration">
          {previewMode === "live"
            ? "直播中"
            : `回看${previewSecond != null ? ` ${clock(Math.floor(previewSecond))}` : ""}`}
        </span>
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
