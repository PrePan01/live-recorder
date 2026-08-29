import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Empty, Modal, Popconfirm, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { FullscreenOutlined, ReloadOutlined, SoundOutlined, MutedOutlined, PlusOutlined } from '@ant-design/icons';
import { useRoomStore } from '../../stores/roomStore';
import { usePreviewStore } from '../../stores/previewStore';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import LiveStatusTag from '../../components/LiveStatusTag';
import type { Room } from '../../types/room';

const VideoPlayer = lazy(() => import('../../components/VideoPlayer'));

const MAX_WALL = 4;

export default function Wall() {
  const { message } = App.useApp();
  const { rooms, fetchRooms } = useRoomStore();
  const openPreview = usePreviewStore((s) => s.open);
  const closePreview = usePreviewStore((s) => s.close);
  const [grid, setGrid] = useState<'2x2' | '3x3'>('2x2');
  const [wallRooms, setWallRooms] = useState<Room[]>([]);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState<Room | null>(null);

  useEffect(() => {
    void fetchRooms().catch(() => message.error('房间加载失败'));
  }, [fetchRooms, message]);

  const available = useMemo(
    () => rooms.filter((r) => r.enabled && !wallRooms.some((w) => w.id === r.id)),
    [rooms, wallRooms],
  );

  const addRoom = (room: Room) => {
    if (wallRooms.length >= MAX_WALL) {
      const replace = wallRooms[wallRooms.length - 1];
      closePreview(replace.id);
      setWallRooms((prev) => [...prev.slice(0, -1), room]);
      message.info(`已替换「${replace.displayName}」，最多 4 路`);
    } else {
      setWallRooms((prev) => [...prev, room]);
    }
    openPreview(room.id);
  };

  const removeRoom = (room: Room) => {
    closePreview(room.id);
    setWallRooms((prev) => prev.filter((r) => r.id !== room.id));
  };

  const gridCols = grid === '2x2' ? 2 : 3;
  const cellSize = grid === '2x2' ? '1fr' : '1fr';

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          多路直播墙
        </Typography.Title>
        <Space wrap>
          <Segmented options={['2x2', '3x3']} value={grid} onChange={(v) => setGrid(v as '2x2' | '3x3')} />
          <Button icon={<PlusOutlined />} onClick={() => setAddOpen(true)} disabled={available.length === 0}>
            添加房间
          </Button>
        </Space>
      </Space>
      {wallRooms.length === 0 ? (
        <Empty description="从右侧「添加房间」选择直播，默认静音，最多 4 路" style={{ marginTop: 60 }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridCols}, ${cellSize})`, gap: 12 }}>
          {wallRooms.map((room) => (
            <Card
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
                  <Popconfirm title="移除该路？录制不受影响" onConfirm={() => removeRoom(room)}>
                    <Button type="text" size="small" danger>
                      移除
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              <Suspense fallback={<Spin style={{ display: 'block', margin: '40px auto' }} />}>
                <VideoPlayer key={`${room.id}-${reloadKey}`} roomId={room.id} muted={!muted[room.id]} />
              </Suspense>
            </Card>
          ))}
        </div>
      )}
      <Modal
        title="添加房间到直播墙"
        open={addOpen}
        footer={null}
        onCancel={() => setAddOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            最多 4 路；添加第 5 路会替换最后一路。默认静音。
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            placeholder="选择直播间"
            options={available.map((r) => ({ value: r.id, label: r.displayName }))}
            onChange={(id) => {
              const room = available.find((r) => r.id === id);
              if (room) {
                addRoom(room);
                setAddOpen(false);
              }
            }}
          />
        </Space>
      </Modal>
      <Modal
        title={`全屏：${fullscreen?.displayName ?? ''}`}
        open={fullscreen !== null}
        footer={null}
        width={960}
        destroyOnHidden
        onCancel={() => setFullscreen(null)}
      >
        {fullscreen ? <VideoPlayer roomId={fullscreen.id} /> : null}
      </Modal>
    </div>
  );
}