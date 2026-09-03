import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Empty, Input, Popconfirm, Row, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EyeOutlined, LinkOutlined, ReloadOutlined, StarFilled, StarOutlined, StopOutlined, VideoCameraAddOutlined } from '@ant-design/icons';
import { useRoomStore } from '../../stores/roomStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import { MonitorStateTag } from '../../components/StatusTags';
import { formatRelative } from '../../utils/format';
import RoomStats from '../../components/RoomStats';
import RoomHealth from '../../components/RoomHealth';
import LiveStatusTag from '../../components/LiveStatusTag';
import LivePredictionBadge from '../../components/LivePredictionBadge';
import PreviewModal from '../../components/PreviewModal';
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
  recentlyStopped,
  autoRecordEnabled,
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
  recentlyStopped?: boolean;
  autoRecordEnabled: boolean;
}) {
  const recording = room.monitorState === 'recording' || room.monitorState === 'reconnecting';
  const onAir = room.lastLiveStatus === 'live';
  return (
    <Card
      className={`lr-room-card ${layout === 'list' ? 'lr-room-card--list' : ''}`}
      styles={{ body: { padding: 14 } }}
      title={
        <Space style={{ minWidth: 0, maxWidth: '100%' }} align="center">
          <PlatformLogoTag platform={room.platform} />
          <Tooltip title={room.displayName} className="lr-room-card__title">
            <Typography.Text strong style={{ fontSize: 14, lineHeight: 1 }} ellipsis>
              {room.displayName}
            </Typography.Text>
          </Tooltip>
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
      <Space className="lr-room-card__status" style={{ marginBottom: 10 }}>
        <LiveStatusTag status={room.lastLiveStatus} />
        <Tag color={autoRecordEnabled ? 'blue' : 'orange'} style={{ marginInlineEnd: 0 }}>
          {autoRecordEnabled ? '自动录' : '未自动录'}
        </Tag>
        <LivePredictionBadge roomId={room.id} />
        {room.tags.length > 0 ? (
          <Space size={[4, 4]} wrap>
            {room.tags.map((t) => (
                <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
                  {t.name}
                </Tag>
            ))}
          </Space>
        ) : null}
      </Space>
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
      <div className="lr-room-card__actions">
        <Button
          size="middle"
          icon={<ReloadOutlined />}
          loading={acting && actingAction === 'check'}
          disabled={acting || room.monitorState === 'checking' || recording}
          onClick={() => onCheck(room)}
        >
          检测
        </Button>
        {onAir || recording ? (
          <Button size="middle" type={recording ? 'primary' : 'default'} icon={<EyeOutlined />} onClick={() => onWatch(room)}>
            观看
          </Button>
        ) : (
          <Tooltip title="未开播，暂时无法观看">
            <Button size="middle" icon={<EyeOutlined />} disabled>
              观看
            </Button>
          </Tooltip>
        )}
        {room.monitorState === 'recording' || room.monitorState === 'reconnecting' ? (
          <Popconfirm title="确定停止当前录制？" onConfirm={() => onStop(room)}>
            <Button size="middle" danger loading={acting && actingAction === 'stop'} icon={<StopOutlined />}>
              停止
            </Button>
          </Popconfirm>
        ) : (
          <Button
            size="middle"
            type="primary"
            icon={<VideoCameraAddOutlined />}
            loading={acting && actingAction === 'record'}
            disabled={acting || recentlyStopped || !onAir}
            onClick={() => onRecord(room)}
          >
            录制
          </Button>
        )}
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
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const [watching, setWatching] = useState<Room | null>(null);
  const [view, setView] = useState<'卡片' | '列表'>(() => (localStorage.getItem('lr-monitor-view') === '列表' ? '列表' : '卡片'));
  const [filter, setFilter] = useState<'全部' | '开播中' | '录制中' | '收藏'>('全部');
  const [keyword, setKeyword] = useState('');
  // 停止后冷却：避免「停止→立即重录」竞态（后端 active 移除晚于 SSE 更新，误 409）。
  const [recentStop, setRecentStop] = useState<Record<string, number>>({});

  useEffect(() => {
    const ids = Object.keys(recentStop);
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      setRecentStop((prev) => {
        const now = Date.now();
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (now - next[id] >= 1200) delete next[id];
        }
        return next;
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [recentStop]);

  const onStopRoom = (room: Room) => {
    setRecentStop((prev) => ({ ...prev, [room.id]: Date.now() }));
    void stopRoomRecording(room.id).catch(() => message.error('停止请求失败'));
  };

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间列表加载失败'));
  }, [fetchRooms, message]);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  const monitorRooms = rooms
    .filter((r) => r.enabled)
    .filter((r) => {
      if (filter === '开播中') return r.lastLiveStatus === 'live';
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

  const listColumns: ColumnsType<Room> = [
    {
      title: '收藏',
      dataIndex: 'favorited',
      width: 60,
      render: (v: boolean, room) => (
        <Button
          type="text"
          size="small"
          icon={v ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={() =>
            void favoriteRoom(room.id, !v).catch((e) =>
              message.error(e instanceof ApiError ? describeError(e.code, e.message) : '操作失败'),
            )
          }
        />
      ),
    },
    { title: '平台', dataIndex: 'platform', width: 80, render: (p) => <PlatformLogoTag platform={p} /> },
    { title: '显示名', dataIndex: 'displayName', ellipsis: true, render: (v: string, room) => (
      <Space size={4}>
        <span>{v}</span>
        {room.titleFallbackUsed ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>（回退）</Typography.Text>
        ) : null}
      </Space>
    ) },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 160,
      render: (ts: Room['tags']) =>
        ts.length === 0 ? '-' : (
          <Space size={[4, 4]} wrap>
            {ts.map((t) => (
              <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>{t.name}</Tag>
            ))}
          </Space>
        ),
    },
    { title: '直播状态', dataIndex: 'lastLiveStatus', width: 100, render: (s) => <LiveStatusTag status={s} /> },
    { title: '监控状态', dataIndex: 'monitorState', width: 100, render: (s) => <MonitorStateTag state={s} /> },
    { title: '最近检测', dataIndex: 'lastCheckedAt', width: 110, render: (t) => formatRelative(t) },
    {
      title: '操作',
      width: 300,
      fixed: 'right' as const,
      render: (_, room) => {
        const recording = room.monitorState === 'recording' || room.monitorState === 'reconnecting';
        const onAir = room.lastLiveStatus === 'live';
        const acting = actingRoomId === room.id;
        return (
          <Space size={0} wrap>
            <Button size="small" type="link" icon={<ReloadOutlined />} loading={acting && actingAction === 'check'} disabled={acting || room.monitorState === 'checking' || recording} onClick={() => void checkRoomNow(room.id).catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '检测失败'))}>
              检测
            </Button>
            <Button size="small" type="link" icon={<EyeOutlined />} disabled={!onAir && !recording} onClick={() => handleWatch(room)}>
              观看
            </Button>
            {recording ? (
              <Popconfirm title="确定停止当前录制？" onConfirm={() => onStopRoom(room)}>
                <Button size="small" type="link" danger icon={<StopOutlined />} loading={acting && actingAction === 'stop'}>
                  停止
                </Button>
              </Popconfirm>
            ) : (
              <Button size="small" type="link" icon={<VideoCameraAddOutlined />} disabled={!onAir || recentStop[room.id] !== undefined} onClick={() => void startRoomRecording(room.id).catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '录制失败'))}>
                录制
              </Button>
            )}
            <Button size="small" type="link" icon={<LinkOutlined />} href={room.url} target="_blank" rel="noopener noreferrer">
              直播间
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="lr-page lr-monitor-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          监控总览
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <Segmented
            options={[
              { label: '全部', value: '全部' },
              { label: `开播中 ${liveCount}`, value: '开播中' },
              { label: `录制中 ${recordingCount}`, value: '录制中' },
              { label: '收藏', value: '收藏' },
            ]}
            value={filter}
            onChange={(v) => setFilter(v as '全部' | '开播中' | '录制中' | '收藏')}
          />
          <Input.Search
            allowClear
            placeholder="搜索房间"
            style={{ width: 180 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Segmented
            options={['卡片', '列表']}
            value={view}
            onChange={(v) => {
              setView(v as '卡片' | '列表');
              localStorage.setItem('lr-monitor-view', v);
            }}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() =>
              void fetchRooms()
                .then(() => message.success('已刷新'))
                .catch(() => message.error('刷新失败，请稍后重试'))
            }
          >
            刷新
          </Button>
        </Space>
      </Space>
      {monitorRooms.length === 0 && !loading ? (
        <Empty description="暂无启用的直播间，请先在「直播间」中添加" />
      ) : view === '列表' ? (
        <Table
          rowKey="id"
          columns={listColumns}
          dataSource={monitorRooms}
          loading={loading}
          sticky={{ offsetScroll: 8 }}
          scroll={{ x: 1100 }}
          pagination={false}
          size="middle"
        />
      ) : (
        <Row gutter={[16, 16]}>
          {monitorRooms.map((room) => (
            <Col key={room.id} xs={24} sm={12} lg={8} xxl={6}>
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
                onStop={onStopRoom}
                recentlyStopped={recentStop[room.id] !== undefined}
                autoRecordEnabled={room.autoRecord ?? settings?.autoRecord ?? true}
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
                layout="card"
              />
            </Col>
          ))}
        </Row>
      )}
      {watching ? (
        <PreviewModal
          room={watching}
          onClose={() => {
            closePreview(watching.id);
            setWatching(null);
          }}
        />
      ) : null}
    </div>
  );
}
