import { Tag, Tooltip, Typography } from "antd";
import type { RoomInsight } from "../api/rooms";

const CONF_META: Record<string, { color: string; text: string }> = {
  high: { color: "green", text: "高" },
  medium: { color: "orange", text: "中" },
  low: { color: "default", text: "低" },
};

function periodFor(time: string | null): string {
  if (!time) return "晚间";
  const hour = Number(time.slice(0, 2));
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 18) return "下午";
  return "晚间";
}

function dateLabel(date: string): string {
  const now = new Date();
  const local = (value: Date) =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date === local(now)) return "今晚";
  if (date === local(tomorrow)) return "明晚";
  const weekday = new Date(`${date}T00:00:00`).getDay();
  return `周${"日一二三四五六"[weekday]}`;
}

/** Monitor supplies prediction through the same bounded batch-insights request. */
export default function LivePredictionBadge({
  insight,
  hidden = false,
}: {
  insight?: RoomInsight;
  hidden?: boolean;
}) {
  if (hidden) return null;
  const value = insight?.prediction;
  if (!value || value.kind === "unavailable") {
    const notice = value?.notice ?? "检测到更多开播次数后显示预测";
    return (
      <Tooltip title={notice}>
        <Tag>开播预测</Tag>
      </Tooltip>
    );
  }
  if (value.kind === "observation" && value.startAt) {
    const text =
      value.sampleCount === 1
        ? `上次 ${value.startAt} 开播`
        : `近 ${value.sampleCount} 次约 ${value.startAt} 开播`;
    return (
      <Tooltip title={value.notice ?? "基于本机开播检测"}>
        <Tag>{text}</Tag>
      </Tooltip>
    );
  }
  if (!value.startAt || !value.confidence) return null;
  const conf = CONF_META[value.confidence];
  const confidence = `置信度${conf.text}`;
  let text: string;
  if (value.kind === "next" && value.nextDate) {
    const date = dateLabel(value.nextDate);
    const time =
      value.slots.length > 1 && value.confidence !== "low" && value.windowStart && value.windowEnd
        ? `${value.windowStart}–${value.windowEnd}`
        : value.timeGranularity === "period"
        ? periodFor(value.startAt)
        : value.timeGranularity === "approximate"
          ? `${value.startAt} 左右`
          : value.startAt;
    const prefix = value.basis === "day_type"
      ? (date === "今晚" || date === "明晚" || date === "周六" || date === "周日" ? "周末常见" : "工作日常见")
      : `预计${date}`;
    text = value.slots.length > 1 && value.confidence === "low"
      ? `检测时间集中在 ${value.slots.length} 个时段`
      : `${prefix} ${time}`;
  } else if (value.slots.length > 1) {
    text = `检测时间集中在 ${value.slots.length} 个时段`;
  } else {
    const time =
      value.timeGranularity === "period"
        ? periodFor(value.startAt)
        : value.startAt;
    text = `常见${time}开播`;
  }
  return (
    <Tooltip title={`基于本机近 60 天的 ${value.sampleCount} 次开播检测`}>
      <Tag color={conf.color}>
        <Typography.Text style={{ fontSize: 12 }}>
          {text} · {confidence}
        </Typography.Text>
      </Tag>
    </Tooltip>
  );
}
