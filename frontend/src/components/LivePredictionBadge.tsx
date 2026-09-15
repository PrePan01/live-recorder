import type { ReactNode } from "react";
import { Popover, Tag, Typography } from "antd";
import type { RoomInsight } from "../api/rooms";

const CONF_META: Record<string, { text: string }> = {
  high: { text: "高" },
  medium: { text: "中" },
  low: { text: "低" },
};

function likelihoodText(value: "high" | "medium" | "low" | null): string {
  if (value === "low") return "有开播可能";
  return `可能性${CONF_META[value ?? "medium"].text}`;
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

function isToday(date: string): boolean {
  const now = new Date();
  return (
    date ===
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  );
}

type Prediction = RoomInsight["prediction"];

function clockMinutes(value: string): number {
  const nextDay = value.startsWith("次日 ");
  const [hour, minute] = value.replace("次日 ", "").split(":").map(Number);
  return (nextDay ? 1440 : 0) + hour * 60 + minute;
}

function regularTime(prediction: Prediction): string {
  if (!prediction.startAt) return "";
  return prediction.timeGranularity === "exact"
    ? prediction.startAt
    : ` ${approximateTime(prediction.startAt)} 左右`;
}

function currentTodaySlot(prediction: Prediction) {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const slots = prediction.slots.map((slot) => ({
    ...slot,
    start: clockMinutes(slot.startAt),
    end: Math.max(clockMinutes(slot.endAt), clockMinutes(slot.startAt) + 20),
  }));
  return (
    slots.find((slot) => minute >= slot.start && minute <= slot.end + 30) ??
    slots
      .filter((slot) => slot.start > minute)
      .sort((a, b) => a.start - b.start)[0]
  );
}

function PredictionTimeline({ prediction }: { prediction: Prediction }) {
  const slots = prediction.slots.map((slot) => {
    const start = clockMinutes(slot.startAt);
    const end = Math.max(clockMinutes(slot.endAt), start + 20);
    return { ...slot, start, end };
  });
  const showNow = !prediction.nextDate || isToday(prediction.nextDate);
  const current = new Date();
  const nowPosition =
    ((current.getHours() * 60 + current.getMinutes()) / 1440) * 100;
  return (
    <div
      className="lr-live-prediction-timeline"
      aria-label="24 小时开播可能时段"
    >
      <div className="lr-live-prediction-timeline__track">
        {slots.map((slot) => (
          <span
            key={`${slot.startAt}-${slot.endAt}`}
            className={`lr-live-prediction-timeline__band lr-live-prediction-timeline__band--${slot.likelihood}`}
            style={{
              left: `${(slot.start / 1440) * 100}%`,
              width: `${Math.min(100 - (slot.start / 1440) * 100, Math.max(3, ((slot.end - slot.start) / 1440) * 100))}%`,
            }}
            aria-label={`${slot.startAt} 至 ${slot.endAt}，开播可能性${CONF_META[slot.likelihood].text}`}
          />
        ))}
        {showNow && (
          <span
            className="lr-live-prediction-timeline__now"
            style={{ left: `${nowPosition}%` }}
            aria-label="当前时间"
          />
        )}
      </div>
      <div className="lr-live-prediction-timeline__hours" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      {prediction.recentObservations.length > 0 && (
        <div
          className="lr-live-prediction-timeline__observations"
          aria-label="近期检测到的开播时间"
        >
          {prediction.recentObservations.map((observation, index) => (
            <span
              key={`${observation.time}-${observation.quality}-${index}`}
              className={`lr-live-prediction-timeline__observation lr-live-prediction-timeline__observation--${observation.quality}`}
              style={{
                left: `${(clockMinutes(observation.time) / 1440) * 100}%`,
              }}
              aria-label={`近期检测到 ${observation.time} 开播`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PredictionPopover({
  prediction,
  likelihood,
  children,
}: {
  prediction: Prediction;
  likelihood: "high" | "medium" | "low" | null;
  children: ReactNode;
}) {
  const title = (
    <>
      <span>开播可能时段</span>
      <span className="lr-live-prediction-popover__likelihood">
        {likelihoodText(likelihood)}
      </span>
    </>
  );
  return (
    <Popover
      title={title}
      content={
        <>
          <div className="lr-live-prediction-popover__usual">
            通常 {regularTime(prediction)}开播
          </div>
          <PredictionTimeline prediction={prediction} />
        </>
      }
      trigger={["hover", "focus"]}
    >
      {children}
    </Popover>
  );
}

function PredictionHint({
  content,
  children,
}: {
  content: string;
  children: ReactNode;
}) {
  return (
    <Popover content={content} trigger={["hover", "focus"]}>
      {children}
    </Popover>
  );
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
    return (
      <PredictionHint content="检测到更多开播记录后形成开播预测">
        <Tag className="lr-live-prediction-tag lr-live-prediction-tag--empty">
          暂无开播预测
        </Tag>
      </PredictionHint>
    );
  }
  if (value.kind === "observation" && value.lastRecordedAt) {
    return (
      <PredictionHint content="样本不足，暂未形成开播预测">
        <Tag className="lr-live-prediction-tag lr-live-prediction-tag--observation">
          最近检测到开播 {value.lastRecordedAt}
        </Tag>
      </PredictionHint>
    );
  }
  if (!value.startAt || !value.confidence) return null;
  const todaySlot =
    value.kind === "next" && value.nextDate && isToday(value.nextDate)
      ? currentTodaySlot(value)
      : undefined;
  const likelihood = todaySlot
    ? (value.todayProbability ?? todaySlot.likelihood)
    : (value.likelihood ?? value.confidence);
  const text = todaySlot
    ? `今天${periodFor(todaySlot.startAt)}开播`
    : `通常${regularTime(value)}开播`;
  return (
    <PredictionPopover prediction={value} likelihood={likelihood}>
      <Tag
        className={`lr-live-prediction-tag lr-live-prediction-tag--${likelihood}`}
      >
        <Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text>
      </Tag>
    </PredictionPopover>
  );
}
