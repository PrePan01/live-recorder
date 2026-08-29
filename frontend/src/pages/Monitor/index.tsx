import { Suspense, lazy, useEffect, useState } from 'react';
import { App, Badge, Button, Card, Col, Empty, Input, Modal, Popconfirm, Row, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { EyeOutlined, LinkOutlined, ReloadOutlined, StarFilled, StarOutlined, StopOutlined, VideoCameraAddOutlined } from '@ant-design/icons';
import { useRoomStore } from '../../stores/roomStore';
import { usePreviewStore } from '../../stores/previewStore';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import RoomStats from '../../components/RoomStats';
import RoomHealth from '../../components/RoomHealth';
import LiveStatusTag from '../../components/LiveStatusTag';
import LivePredictionBadge from '../../components/LivePredictionBadge';
const VideoPlayer = lazy(() => import('../../components/VideoPlayer'));
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import type { Room } from '../../types/room';

function RoomCard({
  room,
  onWatch,
  onCheck,
  onStop,
  onRecord,
  onFavorite,
  layout,
  actingAction,
  acting,
}: {
  room: Room;
  onWatch: (r: Room) => void;
  onCheck: (r: Room) => void;
  onStop: (r: Room) => void;
  onRecord: (r: Room) => void;
  onFavorite: (r: Room, favorited: boolean) => void;
  layout: 'card' | 'list';
  actingAction?: 'check' | 'record' | 'stop';
  acting?: boolean;
}) {
  const recording = room.monitorState === 'recording' || room.monitorState === 'reconnecting';
  const onAir = room.lastLiveStatus === 'live';
  return (
    <Card
      className={`lr-room-card ${layout === 'list' ? 'lr-room-card--list' : ''}`}
      styles={{ body: { padding: 14 } }}
      title={
        <Space style={{ minWidth: 0 }}>
          <PlatformLogoTag platform={room.platform} />
          <span>{room.displayName}</span>
          {room.titleFallbackUsed ? (
            <Tooltip title="显示名为回退/占位来源，平台接口未返回正式标题">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （回退标题）
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      }
      extra={
        <Space size={0}>
          <Button
            type="text"
            size="small"
            aria-label="收藏"
            icon={room.favorited ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
            onClick={() => onFavorite(room, !room.favorited)}
          />
        </Space>
      }
    >
      <div className="lr-room-card__status" style={{ marginBottom: 8 }}>
        <LiveStatusTag status={room.lastLiveStatus} />
        <LivePredictionBadge roomId={room.id} />
      </div>
      {room.tags.length > 0 ? (
        <div style={{ marginBottom: 8 }}>
          <Space size={[4, 4]} wrap>
            {room.tags.map((t) => (
              <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
                {t.name}
              </Tag>
            ))}
          </Space>
        </div>
      ) : null}
      <div className="lr-room-card__stats" style={{ marginBottom: 10, width: '100%' }}>
        <RoomStats
          lastCheckedAt={room.lastCheckedAt}
          startedAt={recording && room.activeRecording ? room.activeRecording.startedAt : null}
          state={room.monitorState}
        />
      </div>
      <div className="lr-room-card__health" style={{ marginBottom: 10 }}>
        <RoomHealth roomId={room.id} />
      </div>
      {room.lastError ? (
        <Typography.Paragraph className="lr-room-card__error" type="danger" style={{ marginBottom: 10, marginTop: 0 }}>
          {room.lastError.message}
        </Typography.Paragraph>
      ) : null}
      {onAir && !recording && room.autoRecord === false ? (
        <Typography.Paragraph type="warning" style={{ marginBottom: 10, marginTop: 0 }}>
          该房间已关闭自动录制，开播未自动录，可手动「录制」
        </Typography.Paragraph>
      ) : null}
      <div className="lr-room-card__actions">
        <Button
          size="middle"
          icon={<ReloadOutlined />}
          loading={acting && actingAction === 'check'}
          disabled={acting || room.monitorState === 'checking' || recording}
          onClick={() => onCheck(room)}
        >
          立即检测
        </Button>
        {recording ? (
          <Button size="middle" type="primary" icon={<EyeOutlined />} onClick={() => onWatch(room)}>
            观看
          </Button>
        ) : (
          <Tooltip title="仅录制中可观看">
            <Button size="middle" icon={<EyeOutlined />} disabled>
              观看
            </Button>
          </Tooltip>
        )}
        {room.monitorState === 'recording' ? (
          <Popconfirm title="确定停止当前录制？" onConfirm={() => onStop(room)}>
            <Button size="middle" danger loading={acting && actingAction === 'stop'} icon={<StopOutlined />}>
              停止
            </Button>
          </Popconfirm>
        ) : (
          <Button size="middle" icon={<StopOutlined />} disabled>
            停止
          </Button>
        )}
        <Button
          size="middle"
          type={recording ? 'default' : 'primary'}
          icon={<VideoCameraAddOutlined />}
          loading={acting && actingAction === 'record'}
          disabled={acting || !onAir || recording}
          onClick={() => onRecord(room)}
        >
          {recording ? '录制中' : '录制'}
        </Button>
        <Button size="middle" icon={<LinkOutlined />} href={room.url} target="_blank" rel="noopener noreferrer">
          直播间
        </Button>
      </div>
    </Card>
  );
}

export default function Monitor() {
  const { message } = App.useApp();
  const { rooms, loading, actingRoomId, actingAction, fetchRooms, checkRoomNow, startRoomRecording, stopRoomRecording, favoriteRoom } = useRoomStore();
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

  const enabledRooms = rooms.filter((r) => r.enabled);
  const liveCount = enabledRooms.filter((r) => r.lastLiveStatus === 'live').length;
  const recordingCount = enabledRooms.filter(
    (r) => r.monitorState === 'recording' || r.monitorState === 'reconnecting',
  ).length;

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
        <Space size={16} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            监控总览
          </Typography.Title>
          <Space size={8} wrap>
            <Badge
              color="green"
              count={liveCount}
              showZero
              title={`开播中 ${liveCount} 间`}
              style={{ boxShadow: 'none' }}
            >
              <Button size="small" icon={<EyeOutlined />}>
                开播中 {liveCount}
              </Button>
            </Badge>
            <Badge
              color="red"
              count={recordingCount}
              showZero
              title={`录制中 ${recordingCount} 间`}
              style={{ boxShadow: 'none' }}
            >
              <Button size="small" icon={<VideoCameraAddOutlined />}>
                录制中 {recordingCount}
              </Button>
            </Badge>
          </Space>
        </Space>
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
        <Row className={view === '列表' ? 'lr-monitor-list' : undefined} gutter={[16, 16]}>
          {monitorRooms.map((room) => (
            <Col key={room.id} xs={24} sm={12} lg={8} xxl={6} {...(view === '列表' ? { span: 24 } : {})} style={{ minWidth: 320 }}>
              <RoomCard
                room={room}
                acting={actingRoomId === room.id}
                actingAction={actingRoomId === room.id ? (actingAction ?? undefined) : undefined}
                onWatch={handleWatch}
                onCheck={(r) =>
                  void checkRoomNow(r.id).catch((e) =>
                    message.error(e instanceof ApiError ? describeError(e.code, e.message) : '检测请求失败'),
                  )
                }
                onStop={(r) => void stopRoomRecording(r.id).catch(() => message.error('停止请求失败'))}
                onRecord={(r) =>
                  void startRoomRecording(r.id).catch((e) =>
                    message.error(e instanceof ApiError ? describeError(e.code, e.message) : '录制请求失败'),
                  )
                }
                onFavorite={(r, fav) =>
                  void favoriteRoom(r.id, fav).catch((e) =>
                    message.error(e instanceof ApiError ? describeError(e.code, e.message) : '收藏操作失败'),
                  )
                }
                layout={view === '列表' ? 'list' : 'card'}
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
