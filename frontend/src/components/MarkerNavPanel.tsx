import { playbackClock as markerClock } from "../utils/player/playbackClock";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Popconfirm,
  Tooltip,
  Typography,
} from "antd";
import {
  EditOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  ExpandOutlined,
  ExportOutlined,
} from "@ant-design/icons";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import { markerNeighbors } from "../utils/timeline/markerNavigation";
import { PendingSegmentRow, type PendingSegment } from "./PendingSegmentRow";

const MARKER_ROW_HEIGHT = 24;
const MARKER_LIST_HEIGHT = 60;

interface MarkerNavPanelProps {
  markers: RecordingMarker[];
  pendingSegment?: PendingSegment;
  currentSecond?: number;
  duration: number;
  onSeek: (second: number) => void;
  liveMode: boolean;
  loading?: boolean;
  blockedReason?: string;
  onEdit?: (marker: RecordingMarker, text: string) => Promise<void>;
  onDelete?: (marker: RecordingMarker) => Promise<void>;
  onRangeEdit?: (
    marker: RecordingMarker,
    start: number,
    end: number,
  ) => Promise<void>;
  onAdjustRange?: (marker: RecordingMarker) => void;
  onPreview?: (marker: RecordingMarker) => void;
  onExport?: (marker: RecordingMarker) => Promise<void>;
  selectingSegments?: boolean;
  selectedSegmentIds?: ReadonlySet<string>;
  onSelectSegment?: (id: string, checked: boolean) => void;
  exportBusy?: boolean;
  gaps?: RecordingGap[];
}

export function MarkerNavPanel({
  markers,
  pendingSegment,
  currentSecond,
  onSeek,
  liveMode,
  loading = false,
  blockedReason,
  onEdit,
  onDelete,
  onAdjustRange,
  onPreview,
  onExport,
  selectingSegments = false,
  selectedSegmentIds,
  onSelectSegment,
  exportBusy = false,
}: MarkerNavPanelProps) {
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
      clickTimer.current = null;
    },
    [markers],
  );
  const openEditor = (marker: RecordingMarker) => {
    if (!onEdit || saving) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
    setEditing(marker);
    setDraft(marker.text);
  };
  const sorted = useMemo(
    () =>
      [...markers].sort(
        (a, b) =>
          a.positionSeconds - b.positionSeconds ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      ),
    [markers],
  );
  const { current } = markerNeighbors(sorted, currentSecond, liveMode);
  const pendingStart = pendingSegment?.start;
  const timeWidth = useMemo(
    () =>
      sorted.reduce(
        (width, marker) =>
          Math.max(
            width,
            markerClock(marker.positionSeconds).length +
              (marker.endPositionSeconds != null
                ? 1 + markerClock(marker.endPositionSeconds).length
                : 0),
          ),
        Math.max(5, pendingSegment ? markerClock(pendingSegment.start).length + 4 : 0),
      ) + 1,
    [sorted, pendingSegment],
  );
  useEffect(() => {
    if (pendingStart != null || current < 0 || !listRef.current) return;
    const top = current * MARKER_ROW_HEIGHT;
    if (
      top < listRef.current.scrollTop ||
      top + MARKER_ROW_HEIGHT > listRef.current.scrollTop + MARKER_LIST_HEIGHT
    ) {
      listRef.current.scrollTop = Math.max(0, top - MARKER_ROW_HEIGHT);
      setScrollTop(listRef.current.scrollTop);
    }
  }, [current, pendingStart]);
  useEffect(() => {
    if (pendingStart == null || !listRef.current) return;
    listRef.current.scrollTop = Math.max(
      0,
      (sorted.length + 1) * MARKER_ROW_HEIGHT - MARKER_LIST_HEIGHT,
    );
    setScrollTop(listRef.current.scrollTop);
  }, [pendingStart, sorted.length]);
  const firstVisible = Math.min(
    Math.max(0, sorted.length - 12),
    Math.max(0, Math.floor(scrollTop / MARKER_ROW_HEIGHT) - 3),
  );
  const lastVisible = Math.min(sorted.length, firstVisible + 12);
  const disabled = Boolean(blockedReason) || loading;
  const seekTo = (marker: RecordingMarker) => {
    if (disabled) return;
    onSeek(marker.positionSeconds);
  };
  if (sorted.length === 0 && !pendingSegment) return null;
  return (
    <section className="lr-marker-nav" aria-label="标记导航">
      {blockedReason ? (
        <Typography.Text
          type="secondary"
          style={{ display: "block", fontSize: 12 }}
        >
          {blockedReason}
        </Typography.Text>
      ) : null}
      <div
        className="lr-marker-nav__list"
        ref={listRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: firstVisible * MARKER_ROW_HEIGHT }} />
        {sorted.slice(firstVisible, lastVisible).map((marker, offset) => {
          const i = firstVisible + offset;
          const segment = marker.endPositionSeconds != null;
          return (
            <div
              key={marker.id}
              className={`lr-marker-nav__row${i === current ? " lr-marker-nav__row--current" : ""}`}
            >
              {selectingSegments && onSelectSegment ? (
                <span className="lr-marker-nav__selection">
                  {segment ? (
                    <Checkbox
                      aria-label={`选择 ${marker.text}`}
                      disabled={exportBusy}
                      checked={selectedSegmentIds?.has(marker.id) ?? false}
                      onChange={(e) =>
                        onSelectSegment(marker.id, e.target.checked)
                      }
                    />
                  ) : null}
                </span>
              ) : null}
              <button
                type="button"
                className="lr-marker-nav__seek"
                disabled={disabled}
                aria-current={i === current ? "true" : undefined}
                title={marker.text}
                onClick={(event) => {
                  if (clickTimer.current) clearTimeout(clickTimer.current);
                  clickTimer.current = null;
                  if (onEdit && event.detail > 0)
                    clickTimer.current = setTimeout(() => {
                      clickTimer.current = null;
                      seekTo(marker);
                    }, 500);
                  else seekTo(marker);
                }}
                onDoubleClick={() => {
                  if (clickTimer.current) clearTimeout(clickTimer.current);
                  clickTimer.current = null;
                  openEditor(marker);
                }}
              >
                <time style={{ width: `${timeWidth}ch` }}>
                  {markerClock(marker.positionSeconds)}
                  {segment ? `—${markerClock(marker.endPositionSeconds!)}` : ""}
                </time>
                <span>{marker.text}</span>
              </button>
              {onEdit ? (
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    aria-label={`编辑 ${marker.text}`}
                    icon={<EditOutlined />}
                    onClick={() => openEditor(marker)}
                  />
                </Tooltip>
              ) : null}
              {segment && onPreview ? (
                <Tooltip title="跳转">
                  <Button
                    type="text"
                    size="small"
                    disabled={disabled}
                    aria-label={`预览 ${marker.text}`}
                    icon={<PlayCircleOutlined />}
                    onClick={() => onPreview(marker)}
                  />
                </Tooltip>
              ) : null}
              {segment && onAdjustRange ? (
                <Tooltip title="调整">
                  <Button
                    type="text"
                    size="small"
                    disabled={saving}
                    aria-label={`调整 ${marker.text} 范围`}
                    icon={<ExpandOutlined />}
                    onClick={() => onAdjustRange(marker)}
                  />
                </Tooltip>
              ) : null}
              {segment && onExport ? (
                <Tooltip title="导出">
                  <Button
                    type="text"
                    size="small"
                    disabled={exportBusy}
                    aria-label={`导出 ${marker.text}`}
                    icon={<ExportOutlined />}
                    onClick={() => void onExport(marker)}
                  />
                </Tooltip>
              ) : null}
              {onDelete ? (
                <Tooltip title="删除">
                  <Popconfirm
                    title={`删除${segment ? "片段" : "标签"}标记？`}
                    onConfirm={() => onDelete(marker)}
                  >
                    <Button
                      type="text"
                      size="small"
                      aria-label={`删除 ${marker.text}`}
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </Tooltip>
              ) : null}
            </div>
          );
        })}
        <div
          style={{ height: (sorted.length - lastVisible) * MARKER_ROW_HEIGHT }}
        />
        {pendingSegment ? (
          <PendingSegmentRow segment={pendingSegment} timeWidth={timeWidth} />
        ) : null}
      </div>
      <Modal
        title="编辑标记"
        open={editing != null}
        confirmLoading={saving}
        okButtonProps={{
          disabled: !draft.trim(),
        }}
        onCancel={() => {
          if (!saving) setEditing(null);
        }}
        onOk={() => {
          if (!editing || !onEdit || !draft.trim() || saving) return;
          setSaving(true);
          void onEdit(editing, draft.trim())
            .then(() => setEditing(null))
            .catch(() => undefined)
            .finally(() => setSaving(false));
        }}
        destroyOnHidden
      >
        <Input
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="标记文字"
        />
      </Modal>
    </section>
  );
}
