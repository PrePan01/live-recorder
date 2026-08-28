import { useEffect, useState } from 'react';
import { Space, Typography } from 'antd';
import { fetchRoomStats, type RoomStats } from '../api/rooms';
import { formatBytes } from '../utils/format';

export default function RoomHealth({ roomId }: { roomId: string }) {
  const [stats, setStats] = useState<RoomStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    void fetchRoomStats(roomId)
      .then((s) => {
        if (!disposed) setStats(s);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [roomId]);

  if (failed) return <Typography.Text type="secondary">健康度不可用</Typography.Text>;
  if (!stats) return null;

  const abnormal = stats.failed > 0 || (stats.successRate < 100 && stats.totalRecordings > 0);

  return (
    <div>
      <Space size={12} wrap>
        <span>
          <Typography.Text type="secondary">近 {stats.days} 天</Typography.Text>{' '}
          <Typography.Text strong>{stats.totalRecordings} 次</Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">成功率</Typography.Text>{' '}
          <Typography.Text strong type={abnormal ? 'danger' : 'success'}>
            {stats.successRate}%
          </Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">占用</Typography.Text>{' '}
          <Typography.Text strong>{formatBytes(stats.totalBytes)}</Typography.Text>
        </span>
      </Space>
      {stats.failed > 0 ? (
        <Typography.Paragraph type="danger" style={{ margin: '6px 0 0' }}>
          近 {stats.days} 天失败 {stats.failed} 次{stats.lastError ? `：${String(stats.lastError.message ?? '')}` : ''}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}