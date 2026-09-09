import { Tag, Tooltip, Typography } from 'antd';
import type { RoomInsight } from '../api/rooms';

const CONF_META: Record<string, { color: string; text: string }> = {
  high: { color: 'green', text: '高' },
  medium: { color: 'orange', text: '中' },
  low: { color: 'default', text: '低' },
};

/** Monitor supplies prediction through the same bounded batch-insights request. */
export default function LivePredictionBadge({ insight }: { insight?: RoomInsight }) {
  const value = insight?.prediction;
  if (!value || !value.startAt || !value.confidence) {
    const notice = value?.notice ?? '暂无预测';
    return (
      <Tooltip title={notice}>
        <Tag>暂无预测</Tag>
      </Tooltip>
    );
  }
  const conf = CONF_META[value.confidence];
  return (
    <Tooltip title={`近 ${value.basedOnDays ?? '?'} 天开播规律`}>
      <Tag color={conf.color}>
        <Typography.Text style={{ fontSize: 12 }}>
          预测 {value.startAt}–{value.endAt} · 置信度{conf.text}
        </Typography.Text>
      </Tag>
    </Tooltip>
  );
}
