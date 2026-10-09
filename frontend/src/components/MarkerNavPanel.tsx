import { playbackClock as markerClock } from "../utils/playbackClock";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal, Tooltip, Typography } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  VideoCameraOutlined,
  EditOutlined,
  ScissorOutlined,
} from "@ant-design/icons";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import { markerClipRange, markerNeighbors } from "../utils/markerNavigation";
import { formatDurationMs } from "../utils/format";

const MARKER_ROW_HEIGHT = 24;
const MARKER_LIST_HEIGHT = 60;

interface MarkerNavPanelProps {
  markers: RecordingMarker[];
  navigationContainer?: HTMLElement | null;
  currentSecond?: number;
  duration: number;
  onSeek: (second: number) => void;
  onReturnToLive?: () => void;
  liveMode: boolean;
  loading?: boolean;
  blockedReason?: string;
  onEdit?: (marker: RecordingMarker, text: string) => Promise<void>;
  onExport?: (start: number, end: number, name: string) => void;
  gaps?: RecordingGap[];
}

export function MarkerNavPanel({
  markers,
  navigationContainer,
  currentSecond,
  duration,
  onSeek,
  onReturnToLive,
  liveMode,
  loading = false,
  blockedReason,
  onEdit,
  onExport,
}: MarkerNavPanelProps) {
  const [editing, setEditing] = useState<RecordingMarker | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const sorted = useMemo(
    () => [...markers].sort((a, b) => a.positionSeconds - b.positionSeconds),
    [markers],
  );
  const { current, previous, next } = markerNeighbors(
    sorted,
    currentSecond,
    liveMode,
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
  const navigation =
    sorted.length > 0 ? (
      <>
        <Tooltip
          title={
            blockedReason ?? (previous < 0 ? "没有上一个标记" : "上一个标记")
          }
        >
          <Button
            size="small"
            type="text"
            aria-label="上一个标记"
            disabled={disabled || previous < 0}
            icon={<LeftOutlined />}
            onClick={() => seekTo(sorted[previous])}
          />
        </Tooltip>
        <Tooltip
          title={blockedReason ?? (next < 0 ? "没有下一个标记" : "下一个标记")}
        >
          <Button
            size="small"
            type="text"
            aria-label="下一个标记"
            disabled={disabled || next < 0}
            icon={<RightOutlined />}
            onClick={() => seekTo(sorted[next])}
          />
        </Tooltip>
      </>
    ) : null;
  return (
    <section className="lr-marker-nav" aria-label="标记导航">
      {navigationContainer
        ? createPortal(navigation, navigationContainer)
        : null}
      {(navigationContainer === undefined && navigation) ||
      (!liveMode && onReturnToLive) ? (
        <div className="lr-marker-nav__toolbar">
          <div className="lr-marker-nav__group">
            {navigationContainer === undefined ? navigation : null}
          </div>
          <div className="lr-marker-nav__group">
            {!liveMode && onReturnToLive ? (
              <Tooltip title="回到直播">
                <Button
                  size="small"
                  type="text"
                  aria-label="回到直播"
                  icon={<VideoCameraOutlined />}
                  onClick={onReturnToLive}
                />
              </Tooltip>
            ) : null}
          </div>
        </div>
      ) : null}
      {loading ? <div className="lr-marker-nav__hint">正在定位…</div> : null}
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
          const clip = markerClipRange(marker.positionSeconds, duration);
          return (
            <div
              key={marker.id}
              className={`lr-marker-nav__row${i === current ? " lr-marker-nav__row--current" : ""}`}
            >
              <button
                type="button"
                className="lr-marker-nav__seek"
                disabled={disabled}
                aria-current={i === current ? "true" : undefined}
                title={marker.text}
                onClick={() => seekTo(marker)}
              >
                <time>{markerClock(marker.positionSeconds)}</time>
                <span>{marker.text}</span>
              </button>
              {onEdit ? (
                <Button
                  type="text"
                  size="small"
                  aria-label={`编辑 ${marker.text}`}
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditing(marker);
                    setDraft(marker.text);
                  }}
                />
              ) : null}
              {onExport ? (
                <Tooltip
                  title={
                    clip
                      ? `导出标记前 5 秒至后 15 秒（${formatDurationMs(clip[0] * 1000)}~${formatDurationMs(clip[1] * 1000)}）`
                      : "暂无可导出的录制内容"
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={`导出 ${marker.text} 片段`}
                    disabled={!clip}
                    icon={<ScissorOutlined />}
                    onClick={() => {
                      if (clip) onExport(clip[0], clip[1], marker.text);
                    }}
                  />
                </Tooltip>
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
        okButtonProps={{ disabled: !draft.trim() }}
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
