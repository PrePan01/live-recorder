import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Empty, Modal, Popconfirm, Segmented, Select, Space, Spin, Typography } from 'antd';
import { FullscreenOutlined, ReloadOutlined, SoundOutlined, MutedOutlined, PlusOutlined } from '@ant-design/icons';
import { useRoomStore } from '../../stores/roomStore';
import { usePreviewStore } from '../../stores/previewStore';
import { MAX_WALL, useWallStore } from '../../stores/wallStore';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import LiveStatusTag from '../../components/LiveStatusTag';
import PreviewModal from '../../components/PreviewModal';
import type { Room } from '../../types/room';

const VideoPlayer = lazy(() => import('../../components/VideoPlayer'));

export default function Wall() {
  const { message } = App.useApp();
  const { rooms, fetchRooms } = useRoomStore();
  const openPreview = usePreviewStore((s) => s.open);
  const closePreview = usePreviewStore((s) => s.close);
  const wallRoomIds = useWallStore((s) => s.roomIds);
  const grid = useWallStore((s) => s.grid);
  const setGrid = useWallStore((s) => s.setGrid);
  const addRooms = useWallStore((s) => s.addRooms);
  const removeWallRoom = useWallStore((s) => s.removeRoom);
  const reconcile = useWallStore((s) => s.reconcile);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState<Room | null>(null);

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间加载失败'));
  }, [fetchRooms, message]);

  useEffect(() => {
    reconcile(rooms);
  }, [rooms, reconcile]);

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const wallRooms = useMemo(
    () => wallRoomIds.map((id) => roomById.get(id)).filter((r): r is Room => r !== undefined),
    [wallRoomIds, roomById],
  );

  const available = useMemo(
    () => rooms.filter((r) => r.enabled && !wallRoomIds.includes(r.id)),
    [rooms, wallRoomIds],
  );

  const remainingSlots = MAX_WALL - wallRoomIds.length;

  const handleAdd = () => {
    if (pickedIds.length === 0) return;
    const res = addRooms(pickedIds);
    res.added.forEach((id) => openPreview(id));
    setPickedIds([]);
    setAddOpen(false);
    message.info(`已添加 ${res.added.length} 路到直播墙`);
  };

  const handleRemove = (room: Room) => {
    closePreview(room.id);
    removeWallRoom(room.id);
    setPickedIds([]);
  };

  return (
    <div className="lr-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          多路直播墙
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <Segmented options={['2x2', '3x3']} value={grid} onChange={(v) => setGrid(v as '2x2' | '3x3')} />
          <Button icon={<PlusOutlined />} onClick={() => setAddOpen(true)} disabled={available.length === 0}>
            添加房间
          </Button>
        </Space>
      </Space>
      {wallRooms.length === 0 ? (
        <Empty description="从「添加房间」选择直播，默认静音，最多 4 路" style={{ marginTop: 60 }} />
      ) : (
        <div className="lr-wall-grid" style={{ gridTemplateColumns: `repeat(${grid === '2x2' ? 2 : 3}, minmax(0, 1fr))` }}>
          {wallRooms.map((room) => (
            <Card
              className="lr-wall-card"
              key={room.id}
              size="small"
              title={
                <Space size={8} style={{ minWidth: 0 }}>
                  <PlatformLogoTag platform={room.platform} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.displayName}</span>
                  <LiveStatusTag status={room.lastLiveStatus} />
                </Space>
              }
              extra={
                <Space size={0}>
                  <Button
                    type="text"
                    size="small"
                    icon={muted[room.id] ? <MutedOutlined /> : <SoundOutlined />}
                    onClick={() => setMuted((m) => ({ ...m, [room.id]: !m[room.id] }))}
                  >
                    {muted[room.id] ? '静音' : '有声'}
                  </Button>
                  <Button type="text" size="small" icon={<FullscreenOutlined />} onClick={() => setFullscreen(room)} />
                  <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => setReloadKey((k) => k + 1)} />
                  <Popconfirm title="移除该路？录制不受影响" onConfirm={() => handleRemove(room)}>
                    <Button type="text" size="small" danger>
                      移除
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              {room.lastLiveStatus === 'live' ? (
                <Suspense fallback={<Spin style={{ display: 'block', margin: '40px auto' }} />}>
                  <VideoPlayer key={`${room.id}-${reloadKey}`} roomId={room.id} platform={room.platform} muted={!muted[room.id]} />
                </Suspense>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    aspectRatio: '16 / 9',
                    background: 'var(--lr-bg-secondary, rgba(0,0,0,0.04))',
                    borderRadius: 8,
                  }}
                >
                  <Typography.Text type="secondary">未开播</Typography.Text>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <Modal
        title="添加房间到直播墙"
        open={addOpen}
        onOk={handleAdd}
        okText="添加"
        okButtonProps={{ disabled: pickedIds.length === 0 }}
        onCancel={() => {
          setPickedIds([]);
          setAddOpen(false);
        }}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {remainingSlots > 0 ? `还可添加 ${remainingSlots} 路，上限 ${MAX_WALL} 路。默认静音。` : `直播墙已满（${MAX_WALL}/${MAX_WALL}），请先移除某一路再添加。`}
          </Typography.Text>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="搜索并选择直播间"
            showSearch
            optionFilterProp="label"
            value={pickedIds}
            onChange={setPickedIds}
            disabled={remainingSlots <= 0}
            maxCount={remainingSlots > 0 ? remainingSlots : undefined}
            options={available.map((r) => ({ value: r.id, label: r.displayName }))}
            maxTagCount="responsive"
          />
        </Space>
      </Modal>
      {fullscreen ? (
        <PreviewModal
          room={fullscreen}
          titlePrefix="全屏"
          defaultWidth={880}
          onClose={() => setFullscreen(null)}
        />
      ) : null}
    </div>
  );
}
