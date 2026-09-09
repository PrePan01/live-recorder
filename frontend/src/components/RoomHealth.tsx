import { Space, Typography } from 'antd';
import type { RoomInsight } from '../api/rooms';
import { formatBytes } from '../utils/format';

/** Monitor supplies this from the bounded batch-insights request. */
export default function RoomHealth({ insight }: { insight?: RoomInsight }) {
  if (!insight) return <Typography.Text type="secondary">健康度不可用</Typography.Text>;
  const value = insight;

  const abnormal = value.failed > 0 || (value.successRate < 100 && value.totalRecordings > 0);

  return (
    <div>
      <Space size={12} wrap>
        <span>
          <Typography.Text type="secondary">近 7 天</Typography.Text>{' '}
          <Typography.Text strong>{value.totalRecordings} 次</Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">成功率</Typography.Text>{' '}
          <Typography.Text strong type={abnormal ? 'danger' : 'success'}>
            {value.successRate}%
          </Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">占用</Typography.Text>{' '}
          <Typography.Text strong>{formatBytes(value.totalBytes)}</Typography.Text>
        </span>
      </Space>
      {value.failed > 0 ? (
        <Typography.Paragraph type="danger" style={{ margin: '6px 0 0' }}>
          近 7 天失败 {value.failed} 次
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}
