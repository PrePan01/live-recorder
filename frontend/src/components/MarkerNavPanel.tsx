import { useState } from 'react';
import { Button, Space, Tooltip, Typography } from 'antd';
import {
  DownOutlined,
  LeftOutlined,
  RightOutlined,
  UpOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { RecordingMarker } from '../types/recording';

interface MarkerNavPanelProps {
  markers: RecordingMarker[];
  /** 当前回看位置（秒）；直播态=undefined。 */
  currentSecond?: number;
  /** 回看定位（复用现有跳播流程）；跳转不改选区/标记/录制。 */
  onSeek: (second: number) => void;
  onReturnToLive?: () => void;
  /** 直播态=「上一个」定位到最新标记。 */
  liveMode: boolean;
  /** 索引未就绪等定位受阻原因（显原因不假跳）。 */
  blockedReason?: string;
}

function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 标记导航（录制中轨道旁可展开列表）：时间+文本按时间排序、当前条目高亮。 */
export function MarkerNavPanel({
  markers,
  currentSecond,
  onSeek,
  onReturnToLive,
  liveMode,
  blockedReason,
}: MarkerNavPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...markers].sort((a, b) => a.positionSeconds - b.positionSeconds);
  // 当前条目：直播态无游标；回看态取不晚于当前位置的最近标记。
  const currentIndex = (() => {
    if (liveMode || currentSecond == null) return -1;
    let idx = -1;
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].positionSeconds <= currentSecond + 0.5) idx = i;
      else break;
    }
    return idx;
  })();

  const seekTo = (second: number) => {
    if (blockedReason) return;
    onSeek(second);
  };
  const goPrev = () => {
    if (blockedReason) return;
    if (liveMode) {
      const last = sorted[sorted.length - 1];
      if (last) onSeek(last.positionSeconds);
      return;
    }
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (currentSecond != null && sorted[i].positionSeconds < currentSecond - 0.5) {
        onSeek(sorted[i].positionSeconds);
        return;
      }
    }
  };
  const goNext = () => {
    if (blockedReason || liveMode || currentSecond == null) return;
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i].positionSeconds > currentSecond + 0.5) {
        onSeek(sorted[i].positionSeconds);
        return;
      }
    }
  };

  return (
    <div style={{ width: 260, flexShrink: 0 }}>
      <Space size={4} wrap>
        <Button
          size="small"
          type="text"
          aria-label={expanded ? '收起标记列表' : '展开标记列表'}
          icon={expanded ? <UpOutlined /> : <DownOutlined />}
          onClick={() => setExpanded((v) => !v)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          标记 {sorted.length > 0 ? `（${sorted.length}）` : ''}
        </Typography.Text>
        <Tooltip title="上一个标记">
          <Button size="small" aria-label="上一个标记" icon={<LeftOutlined />} onClick={goPrev} />
        </Tooltip>
        <Tooltip title="下一个标记">
          <Button size="small" aria-label="下一个标记" icon={<RightOutlined />} onClick={goNext} />
        </Tooltip>
        {onReturnToLive ? (
          <Tooltip title="回到直播">
            <Button
              size="small"
              aria-label="回到直播"
              icon={<VideoCameraOutlined />}
              onClick={onReturnToLive}
            />
          </Tooltip>
        ) : null}
      </Space>
      {blockedReason ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          {blockedReason}
        </Typography.Text>
      ) : null}
      {expanded ? (
        <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 4 }}>
          {sorted.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              暂无标记
            </Typography.Text>
          ) : (
            sorted.map((m, i) => (
              <div
                key={m.id}
                onClick={() => seekTo(m.positionSeconds)}
                style={{
                  padding: '3px 6px',
                  borderRadius: 4,
                  cursor: blockedReason ? 'not-allowed' : 'pointer',
                  background: i === currentIndex ? 'rgba(139,92,246,0.15)' : 'transparent',
                  display: 'flex',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                  {formatClock(m.positionSeconds)}
                </Typography.Text>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.text}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
