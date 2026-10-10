import { playbackClock as clock } from "../utils/playbackClock";
import {
  CaretUpOutlined,
  DeleteOutlined,
  ForwardOutlined,
  ExportOutlined,
  PlusOutlined,
  PushpinOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Popconfirm, Tooltip } from "antd";
import { recordingGapText } from "../utils/recordingGapText";

import {
  GENERIC_GAP_REASON,
  recordingGapKindText,
} from "../utils/recordingGapKindText";
import { recordingSeekTarget } from "../utils/recordingTimeline";

import type { RecordingTrackProps } from "./recording-track/types";
import { useRecordingTrack } from "./recording-track/useRecordingTrack";
export default function RecordingTrack(props: RecordingTrackProps) {
  const {
    mode = "recording",
    seekDisabled = false,
    toolbar,
    children,
    markers,
    editable = false,
    busy = false,
    selectionDisabled = false,
    onQuickAdd,
    addingMarker = false,
    quickAddDisabled = false,
    onDelete,
    segmentActions,
    temporarySegment,
    onSaveRange,
    onExport,
    rangeSelection,
    onCancelRange,
    onSeekIntent,
    onSeekCommit,
    onReturnToLive,
    previewMode,
    previewSecond,
    previewLoading = false,
    seekHint,
    gaps = [],
  } = props;
  const {
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
  } = useRecordingTrack(props);
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
        {(editable || showSelection || segmentActions || onExport) && (
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
            {editable && (
              <Button
                size="small"
                icon={<PlusOutlined />}
                disabled={quickAddDisabled}
                onClick={() => openEdit()}
              >
                标签
              </Button>
            )}
            {segmentActions}
            {rangeSelection != null ? (
              <>
                <Button
                  size="small"
                  type="primary"
                  disabled={selectionSeconds < 1 || busy}
                  onClick={() => void onSaveRange?.(range[0], range[1])}
                >
                  保存范围
                </Button>
                <Button size="small" disabled={busy} onClick={onCancelRange}>
                  取消调整
                </Button>
              </>
            ) : null}
            {onExport ? (
              <Button size="small" icon={<ExportOutlined />}
                disabled={selectionSeconds < 1 || busy || selectionDisabled || rangeSelection != null}
                onClick={() => onExport(range[0], range[1])}>导出选区</Button>
            ) : null}
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
                  const reason = recordingGapText(gap).reason;
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
                            {reason === GENERIC_GAP_REASON
                              ? recordingGapKindText(gap.kind)
                              : reason}
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
                {temporarySegment ? (
                  <div
                    className="lr-recording-track__temporary-segment"
                    style={{
                      left: `${pct(Math.min(...temporarySegment))}%`,
                      width: `${Math.abs(pct(temporarySegment[1]) - pct(temporarySegment[0]))}%`,
                    }}
                  />
                ) : null}
                {(showSelection || !!onExport) && (
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
                        title={`${clock(position)}${marker.endPositionSeconds != null ? `—${clock(marker.endPositionSeconds)}` : ""}：${marker.text}${editable ? "（单击回看，双击编辑）" : ""}`}
                      >
                        <button
                          aria-label={`${clock(position)} · ${marker.text}`}
                          className={`lr-recording-track__marker lr-recording-track__marker--${index % 3}${marker.endPositionSeconds != null ? " lr-recording-track__marker--segment" : ""}`}
                          style={{
                            left: `${pct(position)}%`,
                            ...(marker.endPositionSeconds != null
                              ? {
                                  width: `${Math.max(0, pct(marker.endPositionSeconds) - pct(position))}%`,
                                }
                              : {}),
                          }}
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
