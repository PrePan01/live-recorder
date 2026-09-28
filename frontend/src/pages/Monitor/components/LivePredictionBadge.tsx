import type { ReactNode } from "react";
import { Popover, Tag, Typography } from "antd";
import type { RoomInsight } from "../../../api/rooms";

import {
  clockMinutes,
  timelineShowsNow,
  predictionTitle,
  lastOpeningValue,
  predictionAccuracyText,
  predictionDisplayLikelihood,
  predictionDisplayLevel,
  predictionOpeningDetail,
  timelineBands,
} from "../../../utils/livePrediction";

const CONF_META = {
  high: { text: "高" },
  medium: { text: "中" },
  low: { text: "低" },
};
type Prediction = RoomInsight["prediction"];

function PredictionTimeline({ prediction }: { prediction: Prediction }) {
  const slots = prediction.slots.flatMap((slot) =>
    timelineBands({
      ...slot,
      likelihood: predictionDisplayLikelihood(slot, slot.likelihood),
    }),
  );
  const showNow = timelineShowsNow(prediction);
  const current = new Date();
  const nowPosition =
    ((current.getHours() * 60 + current.getMinutes()) / 1440) * 100;
  return (
    <div
      className="lr-live-prediction-timeline"
      aria-label="24 小时开播可能时段"
    >
      <div className="lr-live-prediction-timeline__track">
        {slots.map((slot) => {
          // 该时段的可能性算不出来（分母不足）时底色不变，只叠一层灰色斜纹，
          // 让"没测过"和"测出来很低"在视觉上分得开。
          const unknown = slot.probabilityKnown !== true;
          return (
            <span
              key={`${slot.startAt}-${slot.endAt}-${slot.start}`}
              className={`lr-live-prediction-timeline__band lr-live-prediction-timeline__band--${slot.likelihood}${unknown ? " lr-live-prediction-timeline__band--unknown" : ""}`}
              style={{
                left: `${(slot.start / 1440) * 100}%`,
                width: `${((slot.end - slot.start) / 1440) * 100}%`,
              }}
              aria-label={`${slot.startAt} 至 ${slot.endAt}，开播可能性${unknown ? "未知" : CONF_META[slot.likelihood].text}`}
            />
          );
        })}
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
  const predictionValue = predictionOpeningDetail(prediction);
  const lastValue = lastOpeningValue(prediction);
  const title = (
    <>
      <span>开播预测</span>
      <span className="lr-live-prediction-popover__likelihood">
        {predictionAccuracyText(prediction, likelihood)}
      </span>
    </>
  );
  return (
    <Popover
      title={title}
      content={
        <>
          {predictionValue && (
            <div className="lr-live-prediction-popover__time-row">
              <span>预计开播</span>
              <span>{predictionValue}</span>
            </div>
          )}
          {lastValue && (
            <div className="lr-live-prediction-popover__time-row">
              <span>上次开播</span>
              <span>{lastValue}</span>
            </div>
          )}
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
          暂无预测
        </Tag>
      </PredictionHint>
    );
  }
  // Retain a graceful presentation for responses from older backend versions.
  if (value.kind === "observation" && value.lastRecordedAt) {
    return (
      <PredictionHint content="检测到更多开播记录后形成开播预测">
        <Tag className="lr-live-prediction-tag lr-live-prediction-tag--observation">
          {value.lastRecordedQuality === "platform"
            ? "上次开播"
            : "上次检测到开播"}{" "}
          {value.lastRecordedAt}
        </Tag>
      </PredictionHint>
    );
  }
  if (!value.startAt || !value.confidence) return null;
  const likelihood = predictionDisplayLikelihood(
    value,
    value.likelihood ?? value.confidence,
  );
  // 颜色与详情那句「预测准确性」同源，避免颜色说高、点开却写低。
  const level = predictionDisplayLevel(
    value,
    value.likelihood ?? value.confidence,
  );
  const text = predictionTitle(value);
  return (
    <PredictionPopover prediction={value} likelihood={likelihood}>
      <Tag
        className={`lr-live-prediction-tag lr-live-prediction-tag--${level}`}
      >
        <Typography.Text style={{ fontSize: 12 }}>{text}</Typography.Text>
      </Tag>
    </PredictionPopover>
  );
}
