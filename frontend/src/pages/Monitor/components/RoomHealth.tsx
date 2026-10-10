import { Space, Typography } from "antd";
import type { RoomInsight } from "../../../api/rooms";
import { formatBytes } from "../../../utils/format";

/** Monitor supplies this from the bounded batch-insights request. */
export default function RoomHealth({
  insight,
  loading,
  failed,
}: {
  insight?: RoomInsight;
  loading?: boolean;
  failed?: boolean;
}) {
  if (!insight)
    return (
      <Typography.Text type="secondary">
        {failed
          ? "录制统计加载失败"
          : loading
            ? "录制统计加载中…"
            : "暂无录制统计"}
      </Typography.Text>
    );
  const value = insight;
  if (value.totalRecordings === 0)
    return <Typography.Text type="secondary">近 7 天暂无录制</Typography.Text>;

  const abnormal =
    value.failed > 0 || (value.successRate < 100 && value.totalRecordings > 0);

  return (
    <div>
      <Space size={[8, 2]} wrap>
        <span>
          <Typography.Text type="secondary">近 7 天</Typography.Text>{" "}
          <Typography.Text strong>{value.totalRecordings} 次</Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">成功率</Typography.Text>{" "}
          <Typography.Text strong type={abnormal ? "danger" : "success"}>
            {value.successRate}%
          </Typography.Text>
        </span>
        <span>
          <Typography.Text type="secondary">大小</Typography.Text>{" "}
          <Typography.Text strong>
            {formatBytes(value.totalBytes)}
          </Typography.Text>
        </span>
      </Space>
    </div>
  );
}
