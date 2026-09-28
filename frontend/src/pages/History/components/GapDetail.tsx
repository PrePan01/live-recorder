import { useState } from "react";
import { Popover, Space, Tag, Typography } from "antd";
import { fetchRecordingGaps } from "../../../api/recordings";
import type { RecordingGap } from "../../../types/recording";
import { formatRelative } from "../../../utils/format";

function gapText(gap: RecordingGap): string {
  const s = Math.round(gap.missingMs / 1000);
  return `${s} 秒`;
}

export default function GapDetail({
  recordingId,
  missingSeconds,
  gapCount,
}: {
  recordingId: string;
  missingSeconds: number;
  gapCount?: number;
}) {
  const [gaps, setGaps] = useState<RecordingGap[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    if (gaps !== null) return;
    try {
      setGaps(await fetchRecordingGaps(recordingId));
    } catch {
      setFailed(true);
    }
  };

  return (
    <Popover
      trigger="click"
      onOpenChange={(open) => {
        if (open) void load();
      }}
      content={
        <div style={{ maxWidth: 320 }}>
          {failed ? (
            <Typography.Text type="secondary">缺失明细加载失败</Typography.Text>
          ) : gaps === null ? (
            <Typography.Text type="secondary">加载中…</Typography.Text>
          ) : gaps.length === 0 ? (
            <Typography.Text type="secondary">暂无缺失事件记录</Typography.Text>
          ) : (
            <Space orientation="vertical" size={6}>
              <Typography.Text style={{ fontSize: 12, fontWeight: 700 }}>
                共 {gaps.length} 次中断 · 累计{" "}
                {Math.round(
                  gaps.reduce((sum, g) => sum + g.missingMs, 0) / 1000,
                )}{" "}
                秒
              </Typography.Text>
              {gaps.map((g) => (
                <Space key={g.id} size={8} wrap>
                  <Tag style={{ marginInlineEnd: 0 }}>{gapText(g)}</Tag>
                  <Typography.Text style={{ fontSize: 12 }}>
                    {formatRelative(g.startedAt)} 恢复 · {g.kind}
                  </Typography.Text>
                  {g.evidence ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {g.evidence}
                    </Typography.Text>
                  ) : null}
                </Space>
              ))}
            </Space>
          )}
        </div>
      }
    >
      <Typography.Text
        type="warning"
        style={{ fontSize: 12, cursor: "pointer" }}
      >
        {gapCount != null
          ? `${gapCount} 次中断·共 ${missingSeconds} 秒`
          : `中途缺失 ${missingSeconds} 秒`}
      </Typography.Text>
    </Popover>
  );
}
