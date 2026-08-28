import { Suspense, lazy, useEffect, useState } from 'react';
import { App, Button, Card, Col, Empty, Input, Modal, Popconfirm, Row, Segmented, Space, Spin, Tooltip, Typography } from 'antd';
import { EyeOutlined, ReloadOutlined, StarFilled, StarOutlined, StopOutlined } from '@ant-design/icons';
import { useRoomStore } from '../../stores/roomStore';
import { usePreviewStore } from '../../stores/previewStore';
import { MonitorStateTag } from '../../components/StatusTags';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import RoomStats from '../../components/RoomStats';
const VideoPlayer = lazy(() => import('../../components/VideoPlayer'));
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import type { Room } from '../../types/room';

function RoomCard({
  room,
  onWatch,
  onCheck,
  onStop,
  onFavorite,
}: {
  room: Room;
  onWatch: (r: Room) => void;
  onCheck: (r: Room) => void;
  onStop: (r: Room) => void;
  onFavorite: (r: Room, favorited: boolean) => void;
}) {
  const recording = room.monitorState === 'recording' || room.monitorState === 'reconnecting';
  return (
    <Card
      title={
        <Space>
          <PlatformLogoTag platform={room.platform} />
          <span>{room.displayName}</span>
        </Space>
      }
      extra={<MonitorStateTag state={room.monitorState} />}
      actions={[
        <Button
          key="check"
          type="text"
          icon={<ReloadOutlined />}
          disabled={room.monitorState === 'checking' || recording}
          onClick={() => onCheck(room)}
        >
          立即检测
        </Button>,
        recording ? (
          <Button key="watch" type="text" icon={<EyeOutlined />} onClick={() => onWatch(room)}>
            观看
          </Button>
        ) : (
          <Tooltip key="watch" title="仅录制中可观看">
            <Button type="text" icon={<EyeOutlined />} disabled>
              观看
            </Button>
          </Tooltip>
        ),
        room.monitorState === 'recording' ? (
          <Popconfirm key="stop" title="确定停止当前录制？" onConfirm={() => onStop(room)}>
            <Button type="text" danger icon={<StopOutlined />}>
              停止
            </Button>
          </Popconfirm>
        ) : (
          <Button key="stop" type="text" icon={<StopOutlined />} disabled>
            停止
          </Button>
        ),
        <Button
          key="favorite"
          type="text"
          icon={room.favorited ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={() => onFavorite(room, !room.favorited)}
        >
          {room.favorited ? '已收藏' : '收藏'}
        </Button>,
      ]}
    >
      <RoomStats
        lastCheckedAt={room.lastCheckedAt}
        startedAt={recording && room.activeRecording ? room.activeRecording.startedAt : null}
        state={room.monitorState}
      />
      {room.lastError ? (
        <Typography.Paragraph type="danger" ellipsis={{ rows: 1 }} style={{ marginBottom: 0, marginTop: 8 }}>
          {room.lastError.message}
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}

export default function Monitor() {
  const { message } = App.useApp();
  const { rooms, loading, fetchRooms, checkRoomNow, stopRoomRecording, favoriteRoom } = useRoomStore();
  const openPreview = usePreviewStore((s) => s.open);
  const closePreview = usePreviewStore((s) => s.close);
  const [watching, setWatching] = useState<Room | null>(null);
  const [view, setView] = useState<'卡片' | '列表'>('卡片');
  const [filter, setFilter] = useState<'全部' | '录制中' | '收藏'>('全部');
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间列表加载失败'));
  }, [fetchRooms, message]);

  const monitorRooms = rooms
    .filter((r) => r.enabled)
    .filter((r) => {
      if (filter === '录制中') return r.monitorState === 'recording' || r.monitorState === 'reconnecting';
      if (filter === '收藏') return r.favorited;
      return true;
    })
    .filter((r) => {
      const kw = keyword.trim().toLowerCase();
      return !kw || r.displayName.toLowerCase().includes(kw) || r.url.toLowerCase().includes(kw);
    })
    .sort((a, b) => Number(b.favorited) - Number(a.favorited));

  const handleWatch = (room: Room) => {
    if (!openPreview(room.id)) {
      message.warning(describeError('PREVIEW_LIMIT_REACHED'));
      return;
    }
    setWatching(room);
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          监控总览
        </Typography.Title>
        <Space>
          <Segmented
            options={['全部', '录制中', '收藏']}
            value={filter}
            onChange={(v) => setFilter(v as '全部' | '录制中' | '收藏')}
          />
          <Input.Search
            allowClear
            placeholder="搜索房间"
            style={{ width: 180 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Segmented options={['卡片', '列表']} value={view} onChange={(v) => setView(v as '卡片' | '列表')} />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void fetchRooms()}>
            刷新
          </Button>
        </Space>
      </Space>
      {monitorRooms.length === 0 && !loading ? (
        <Empty description="暂无启用的直播间，请先在「直播间」中添加" />
      ) : (
        <Row gutter={[16, 16]}>
          {monitorRooms.map((room) => (
            <Col key={room.id} xs={24} sm={12} lg={8} xxl={6} {...(view === "列表" ? { span: 24 } : {})}>
              <RoomCard
                room={room}
                onWatch={handleWatch}
                onCheck={(r) =>
                  void checkRoomNow(r.id).catch((e) =>
                    message.error(e instanceof ApiError ? describeError(e.code, e.message) : '检测请求失败'),
                  )
                }
                onStop={(r) => void stopRoomRecording(r.id).catch(() => message.error('停止请求失败'))}
                onFavorite={(r, fav) =>
                  void favoriteRoom(r.id, fav).catch((e) =>
                    message.error(e instanceof ApiError ? describeError(e.code, e.message) : '收藏操作失败'),
                  )
                }
              />
            </Col>
          ))}
        </Row>
      )}
      <Modal
        open={watching !== null}
        title={`观看：${watching?.displayName ?? ''}`}
        footer={null}
        width={720}
        destroyOnHidden
        onCancel={() => {
          if (watching) closePreview(watching.id);
          setWatching(null);
        }}
      >
        {watching ? (
          <Suspense fallback={<Spin style={{ display: 'block', margin: '80px auto' }} />}>
            <VideoPlayer roomId={watching.id} />
          </Suspense>
        ) : null}
      </Modal>
    </div>
  );
}
