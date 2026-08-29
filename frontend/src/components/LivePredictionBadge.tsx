import { useEffect, useState } from 'react';
import { Tag, Tooltip, Typography } from 'antd';
import { fetchLivePrediction } from '../api/notification';
import type { LivePrediction } from '../types/notification';

const CONF_META: Record<string, { color: string; text: string }> = {
  high: { color: 'green', text: '高' },
  medium: { color: 'orange', text: '中' },
  low: { color: 'default', text: '低' },
};

export default function LivePredictionBadge({ roomId }: { roomId: string }) {
  const [pred, setPred] = useState<LivePrediction | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setFailed(false);
    fetchLivePrediction(roomId)
      .then((p) => {
        if (!disposed) setPred(p);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [roomId]);

  if (failed || !pred || !pred.startAt || !pred.confidence) {
    const notice = pred?.notice ?? '暂无预测';
    return (
      <Tooltip title={notice}>
        <Tag>暂无预测</Tag>
      </Tooltip>
    );
  }
  const conf = CONF_META[pred.confidence];
  return (
    <Tooltip title={`近 ${pred.basedOnDays ?? '?'} 天开播规律`}>
      <Tag color={conf.color}>
        <Typography.Text style={{ fontSize: 12 }}>
          预测 {pred.startAt}–{pred.endAt} · 置信度{conf.text}
        </Typography.Text>
      </Tag>
    </Tooltip>
  );
}