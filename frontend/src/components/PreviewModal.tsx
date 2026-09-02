import { useEffect, useRef, useState } from 'react';
import { App, Button, Modal, Popconfirm, Tooltip } from 'antd';
import { StopOutlined, VideoCameraAddOutlined } from '@ant-design/icons';
import type { Room } from '../types/room';
import { useRoomStore } from '../stores/roomStore';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import VideoPlayer from './VideoPlayer';

const MIN_WIDTH = 320;
const MAX_WIDTH = 1200;

/**
 * 直播观看弹窗（#194）：视频画面右下角拖拽调整大小 + 画面下方录制/停止按钮。
 * 监控总览与直播墙共用；录制状态与监控卡片联动（同 roomStore）。
 */
export default function PreviewModal({
  room,
  onClose,
  titlePrefix = '观看',
  defaultWidth = 640,
}: {
  room: Room;
  onClose: () => void;
  titlePrefix?: string;
  defaultWidth?: number;
}) {
  const { message } = App.useApp();
  const { rooms, actingRoomId, actingAction, startRoomRecording, stopRoomRecording } = useRoomStore();
  const [width, setWidth] = useState(defaultWidth);
  const [recentStop, setRecentStop] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const live = rooms.find((r) => r.id === room.id) ?? room;
  const recording = live.monitorState === 'recording' || live.monitorState === 'reconnecting';
  const onAir = live.lastLiveStatus === 'live';
  const busy = actingRoomId === room.id;

  useEffect(() => {
    if (!recentStop) return;
    const t = setTimeout(() => setRecentStop(false), 1200);
    return () => clearTimeout(t);
  }, [recentStop]);

  const handleStart = () => {
    void startRoomRecording(room.id).catch((e) =>
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '录制请求失败'),
    );
  };

  const handleStop = () => {
    setRecentStop(true);
    void stopRoomRecording(room.id).catch(() => message.error('停止请求失败'));
  };

  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startW + (ev.clientX - dragRef.current.startX))));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <Modal
      open
      title={`${titlePrefix}：${room.displayName}`}
      footer={null}
      width={Math.min(width + 48, 1280)}
      destroyOnHidden
      onCancel={onClose}
      styles={{ body: { padding: 12 } }}
    >
      <div>
        <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
          <VideoPlayer
            // preview-only → recording 会切换到全新 FLV 时间线；强制重建播放器，不能复用旧 MSE。
            key={`${room.id}:${recording ? 'recording' : 'preview'}`}
            roomId={room.id}
            platform={room.platform}
          />
          <div
            onMouseDown={onHandleDown}
            title="拖动调整大小"
            style={{
              position: 'absolute',
              right: 4,
              bottom: 4,
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              zIndex: 2,
              borderRight: '3px solid rgba(255,255,255,0.75)',
              borderBottom: '3px solid rgba(255,255,255,0.75)',
              borderBottomRightRadius: 4,
              background: 'rgba(0,0,0,0.25)',
            }}
          />
        </div>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          {recording ? (
            <Popconfirm title="确定停止当前录制？" onConfirm={handleStop}>
              <Button size="small" danger icon={<StopOutlined />} loading={busy && actingAction === 'stop'}>
                停止录制
              </Button>
            </Popconfirm>
          ) : (
            <Tooltip title={!onAir ? '未开播，无法录制' : undefined}>
              <Button
                size="small"
                type="primary"
                icon={<VideoCameraAddOutlined />}
                disabled={!onAir || recentStop}
                loading={busy && actingAction === 'record'}
                onClick={handleStart}
              >
                录制
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </Modal>
  );
}
