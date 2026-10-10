import { useState } from "react";
import { Popover, Space, Tag, Typography } from "antd";
import { fetchRecordingGaps } from "../../../api/recordings";
import type { RecordingGap } from "../../../types/recording";
import { formatRelative } from "../../../utils/format";
import { recordingGapSummary } from "../../../utils/recordingGapSummary";
import { recordingGapText } from "../../../utils/recordingGapText";
import { recordingGapPosition } from "../../../utils/recordingGapPosition";
import { GENERIC_GAP_REASON, recordingGapKindText } from "../../../utils/recordingGapKindText";

function gapPositionMs(gap: RecordingGap): number | undefined {
  return gap.positionMs != null && Number.isFinite(gap.positionMs)
    ? gap.positionMs
    : undefined;
}

function gapText(gap: RecordingGap): string {
  const s = Math.round(gap.missingMs / 1000);
  return `${s} 秒`;
}

export default function GapDetail({
  recordingId,
  recordingStartedAt,
  missingMs,
  gapCount,
  estimated,
  onLocate,
}: {
  recordingId: string;
  recordingStartedAt: string;
  missingMs: number;
  gapCount?: number;
  /** 旧记录估算位：汇总文案带「约」。 */
  estimated?: boolean;
  /** 点击条目回看定位（可播轴秒）；不传则条目不可点。 */
  onLocate?: (positionSecond: number) => void;
}) {
  const [gaps, setGaps] = useState<RecordingGap[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { missingSeconds, unlistedSeconds } = recordingGapSummary(
    missingMs,
    gaps ?? [],
  );

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
          ) : (
            <Space orientation="vertical" size={6}>
              <Typography.Text style={{ fontSize: 12, fontWeight: 700 }}>
                {gapCount != null
                  ? `共 ${gapCount} 次中断，`
                  : gaps.length > 0
                    ? `共 ${gaps.length} 次中断，`
                    : ""}
                {estimated ? "约 " : ""}累计 {missingSeconds} 秒
              </Typography.Text>
              {unlistedSeconds > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  另有未定位缺失 {unlistedSeconds} 秒（位置或原因未知，不伪造）
                </Typography.Text>
              ) : null}
              {gaps.length === 0 ? (
                <Typography.Text type="secondary">
                  暂无缺失事件记录
                </Typography.Text>
              ) : null}
              {gaps.map((g) => {
                const { status, reason: reasonRaw } = recordingGapText(g);
                // 通用空话（未记因）回退 kind 人话：source_stall 等粗归因可辨。
                const reason =
                  reasonRaw && reasonRaw !== GENERIC_GAP_REASON
                    ? reasonRaw
                    : recordingGapKindText(g.kind);
                const position = recordingGapPosition(
                  g,
                  gaps,
                  recordingStartedAt,
                );
                return (
                  <Space
                    key={g.id}
                    orientation="vertical"
                    size={4}
                    style={onLocate ? { cursor: "pointer" } : undefined}
                    onClick={
                      onLocate && gapPositionMs(g) != null
                        ? () => onLocate(gapPositionMs(g)! / 1000)
                        : undefined
                    }
                  >
                    <Space size={8} wrap>
                      <Tag style={{ marginInlineEnd: 0 }}>{gapText(g)}</Tag>
                      <Typography.Text style={{ fontSize: 12 }}>
                        {formatRelative(g.endedAt)} {status}
                      </Typography.Text>
                    </Space>
                    <Typography.Text style={{ fontSize: 12 }}>
                      录像位置：{position != null ? `${g.estimated ? "约 " : ""}${position}` : "无法确定"}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {reason}
                    </Typography.Text>
                  </Space>
                );
              })}
              {unlistedSeconds > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  另有 {unlistedSeconds} 秒不明原因缺失
                </Typography.Text>
              ) : null}
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
