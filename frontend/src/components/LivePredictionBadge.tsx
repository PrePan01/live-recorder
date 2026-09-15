import type { ReactNode } from "react";
import { Popover, Tag, Typography } from "antd";
import type { RoomInsight } from "../api/rooms";

const CONF_META: Record<string, { color: string; text: string }> = {
  high: { color: "green", text: "高" },
  medium: { color: "orange", text: "中" },
  low: { color: "default", text: "低" },
};

function likelihoodText(value: "high" | "medium" | "low" | null): string {
  return `可能性${CONF_META[value ?? "low"].text}`;
}

function periodFor(time: string | null): string {
  if (!time) return "晚间";
  const hour = Number(time.slice(0, 2));
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 18) return "下午";
  return "晚间";
}

/** Round uncertain predictions to a readable 15-minute display interval. */
function approximateTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return time;
  const rounded = Math.round((hour * 60 + minute) / 15) * 15;
  const total = ((rounded % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
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

function isToday(date: string): boolean {
  const now = new Date();
  return date === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type Prediction = RoomInsight["prediction"];

function clockMinutes(value: string): number {
  const nextDay = value.startsWith("次日 ");
  const [hour, minute] = value.replace("次日 ", "").split(":").map(Number);
  return (nextDay ? 1440 : 0) + hour * 60 + minute;
}

function PredictionTimeline({ prediction }: { prediction: Prediction }) {
  const slots = prediction.slots.map((slot) => {
    const start = clockMinutes(slot.startAt);
    const end = Math.max(clockMinutes(slot.endAt), start + 20);
    return { ...slot, start, end };
  });
  const showNow = !prediction.nextDate || isToday(prediction.nextDate);
  const current = new Date();
  const nowPosition = ((current.getHours() * 60 + current.getMinutes()) / 1440) * 100;
  return (
    <div className="lr-live-prediction-timeline" aria-label="24 小时开播可能时段">
      <div className="lr-live-prediction-timeline__track">
        {slots.map((slot) => (
          <span
            key={`${slot.startAt}-${slot.endAt}`}
            className={`lr-live-prediction-timeline__band lr-live-prediction-timeline__band--${slot.likelihood}`}
            style={{ left: `${(slot.start / 1440) * 100}%`, width: `${Math.min(100 - (slot.start / 1440) * 100, Math.max(3, ((slot.end - slot.start) / 1440) * 100))}%` }}
            aria-label={`${slot.startAt} 至 ${slot.endAt}，开播可能性${CONF_META[slot.likelihood].text}`}
          />
        ))}
        {showNow && <span className="lr-live-prediction-timeline__now" style={{ left: `${nowPosition}%` }} aria-label="当前时间" />}
      </div>
      <div className="lr-live-prediction-timeline__hours" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </div>
  );
}

function PredictionPopover({ prediction, children }: { prediction: Prediction; children: ReactNode }) {
  const title = prediction.confidence ? <><span>开播可能时段</span><span className="lr-live-prediction-popover__reliability">可靠性{CONF_META[prediction.confidence].text}</span></> : "开播可能时段";
  return <Popover title={title} content={<PredictionTimeline prediction={prediction} />} trigger={["hover", "focus"]}>{children}</Popover>;
}

function PredictionHint({ content, children }: { content: string; children: ReactNode }) {
  return <Popover content={content} trigger={["hover", "focus"]}>{children}</Popover>;
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
    return <PredictionHint content="检测到更多开播记录后形成开播预测"><Tag>暂无开播预测</Tag></PredictionHint>;
  }
  if (value.kind === "observation" && value.lastRecordedAt) {
    return <PredictionHint content="样本不足，暂未形成开播预测"><Tag>最近检测到开播：{value.lastRecordedAt}</Tag></PredictionHint>;
  }
  if (!value.startAt || !value.confidence) return null;
  const conf = CONF_META[value.confidence];
  let text: string;
  if (value.kind === "next" && value.nextDate) {
    const date = dateLabel(value.nextDate);
    if (isToday(value.nextDate)) {
      const likelihood = value.todayProbability ?? value.likelihood;
      text = `今天${periodFor(value.startAt)}开播 · ${likelihoodText(likelihood)}`;
      return <PredictionPopover prediction={value}><Tag color={CONF_META[likelihood ?? value.confidence].color}><Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text></Tag></PredictionPopover>;
    }
    const time = value.timeGranularity === "exact" ? value.startAt : `${approximateTime(value.startAt)} 左右`;
    const prefix = value.basis === "day_type"
      ? (date === "今晚" || date === "明晚" || date === "周六" || date === "周日" ? "周末" : "工作日")
      : date;
    text = `${prefix} ${time}开播 · ${likelihoodText(value.likelihood)}`;
  } else {
    const time = value.timeGranularity === "exact" ? value.startAt : `${approximateTime(value.startAt)} 左右`;
    text = `通常${time}开播 · ${likelihoodText(value.likelihood)}`;
  }
  return <PredictionPopover prediction={value}><Tag color={conf.color}><Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text></Tag></PredictionPopover>;
}
