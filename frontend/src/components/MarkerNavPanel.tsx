import { playbackClock as markerClock } from "../utils/playbackClock";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Typography,
} from "antd";
import {
  EditOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  ExpandOutlined,
} from "@ant-design/icons";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import { markerNeighbors } from "../utils/markerNavigation";

const MARKER_ROW_HEIGHT = 24;
const MARKER_LIST_HEIGHT = 60;

interface MarkerNavPanelProps {
  markers: RecordingMarker[];
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
  selectingSegments?: boolean;
  selectedSegmentIds?: ReadonlySet<string>;
  onSelectSegment?: (id: string, checked: boolean) => void;
  exportBusy?: boolean;
  gaps?: RecordingGap[];
}

export function MarkerNavPanel({
  markers,
  currentSecond,
  duration,
  onSeek,
  liveMode,
  loading = false,
  blockedReason,
  onEdit,
  onDelete,
  onRangeEdit,
  onAdjustRange,
  onPreview,
  selectingSegments = false,
  selectedSegmentIds,
  onSelectSegment,
  exportBusy = false,
}: MarkerNavPanelProps) {
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
  }, [markers]);
  const openEditor = (marker: RecordingMarker) => {
    if (!onEdit || saving) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
    setEditing(marker);
    setDraft(marker.text);
    setRangeStart(marker.positionSeconds);
    setRangeEnd(marker.endPositionSeconds ?? 0);
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
  const timeWidth = useMemo(
    () => sorted.reduce((width, marker) => Math.max(
      width,
      markerClock(marker.positionSeconds).length +
        (marker.endPositionSeconds != null ? 1 + markerClock(marker.endPositionSeconds).length : 0),
    ), 5) + 1,
    [sorted],
  );
  useEffect(() => {
    if (current < 0 || !listRef.current) return;
    const top = current * MARKER_ROW_HEIGHT;
    if (
      top < listRef.current.scrollTop ||
      top + MARKER_ROW_HEIGHT > listRef.current.scrollTop + MARKER_LIST_HEIGHT
    ) {
      listRef.current.scrollTop = Math.max(0, top - MARKER_ROW_HEIGHT);
      setScrollTop(listRef.current.scrollTop);
    }
  }, [current]);
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
  if (sorted.length === 0) return null;
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
                      onChange={(e) => onSelectSegment(marker.id, e.target.checked)}
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
                <Button
                  type="text"
                  size="small"
                  aria-label={`编辑 ${marker.text}`}
                  icon={<EditOutlined />}
                  onClick={() => openEditor(marker)}
                />
              ) : null}
              {segment && onPreview ? (
                <Button
                  type="text"
                  size="small"
                  disabled={disabled}
                  aria-label={`预览 ${marker.text}`}
                  icon={<PlayCircleOutlined />}
                  onClick={() => onPreview(marker)}
                />
              ) : null}
              {segment && onAdjustRange ? (
                <Button
                  type="text"
                  size="small"
                  disabled={saving}
                  aria-label={`调整 ${marker.text} 范围`}
                  icon={<ExpandOutlined />}
                  onClick={() => onAdjustRange(marker)}
                />
              ) : null}
              {onDelete ? (
                <Popconfirm
                  title={`删除${segment ? "片段" : "标签"}标记？导出文件不受影响。`}
                  onConfirm={() => onDelete(marker)}
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={`删除 ${marker.text}`}
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>
              ) : null}
            </div>
          );
        })}
        <div
          style={{ height: (sorted.length - lastVisible) * MARKER_ROW_HEIGHT }}
        />
      </div>
      <Modal
        title="编辑标记"
        open={editing != null}
        confirmLoading={saving}
        okButtonProps={{
          disabled:
            !draft.trim() ||
            (editing?.endPositionSeconds != null &&
              (rangeStart < 0 ||
                rangeEnd - rangeStart < 1 ||
                rangeEnd > duration)),
        }}
        onCancel={() => {
          if (!saving) setEditing(null);
        }}
        onOk={() => {
          if (!editing || !onEdit || !draft.trim() || saving) return;
          setSaving(true);
          const save = async () => {
            if (
              editing.endPositionSeconds != null &&
              onRangeEdit &&
              (rangeStart !== editing.positionSeconds ||
                rangeEnd !== editing.endPositionSeconds)
            ) {
              if (
                rangeStart < 0 ||
                rangeEnd - rangeStart < 1 ||
                rangeEnd > duration
              )
                throw new Error("片段范围非法");
              await onRangeEdit(editing, rangeStart, rangeEnd);
            }
            await onEdit(editing, draft.trim());
          };
          void save()
            .then(() => setEditing(null))
            .catch(() => undefined)
            .finally(() => setSaving(false));
        }}
        destroyOnHidden
      >
        {editing?.endPositionSeconds != null && onRangeEdit ? (
          <Space style={{ marginBottom: 8 }}>
            <InputNumber
              aria-label="片段起点"
              min={0}
              max={Math.max(0, rangeEnd - 1)}
              value={rangeStart}
              onChange={(v) => setRangeStart(v ?? 0)}
            />
            <InputNumber
              aria-label="片段终点"
              min={rangeStart + 1}
              max={duration}
              value={rangeEnd}
              onChange={(v) => setRangeEnd(v ?? 0)}
            />
          </Space>
        ) : null}
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
