import type { RoomInsight } from "../api/rooms";
type Prediction = RoomInsight["prediction"];
export function clockMinutes(value: string): number {
  const [h, m] = value.replace("次日 ", "").split(":").map(Number);
  return (value.startsWith("次日 ") ? 1440 : 0) + h * 60 + m;
}
export function isToday(date: string, now = new Date()): boolean {
  return date === localDate(now);
}
export function timelineShowsNow(
  prediction: Prediction,
  now = new Date(),
): boolean {
  const start = timestamp(prediction, "windowStart"),
    end = timestamp(prediction, "windowEnd");
  if (end && prediction.nextDateEnd) {
    const last = new Date(`${prediction.nextDateEnd}T00:00:00`);
    last.setMinutes(clockMinutes(prediction.windowEnd ?? "00:00"));
    end.setTime(last.getTime());
  }
  if (start && end)
    return (
      localDate(now) >= localDate(start) && localDate(now) <= localDate(end)
    );
  return !prediction.nextDate || isToday(prediction.nextDate, now);
}
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function timestamp(
  prediction: Prediction,
  field: "start" | "windowStart" | "windowEnd",
): Date | null {
  const precise =
    field === "start"
      ? prediction.startTimestamp
      : field === "windowStart"
        ? prediction.windowStartTimestamp
        : prediction.windowEndTimestamp;
  if (precise) {
    const date = new Date(precise);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const time = field === "start" ? prediction.startAt : prediction[field];
  if (!time || !prediction.nextDate) return null;
  const d = new Date(`${prediction.nextDate}T00:00:00`);
  d.setMinutes(clockMinutes(time));
  return d;
}
function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function dateLabel(date: Date, now: Date): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (day(date) - day(now)) / 86400000;
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  if (offset === 2) return "后天";
  const weekStart = day(now) - ((now.getDay() + 6) % 7) * 86400000;
  const week = Math.floor((day(date) - weekStart) / (7 * 86400000));
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    date.getDay()
  ];
  return week === 0
    ? weekday
    : week === 1
      ? `下${weekday}`
      : `${date.getMonth() + 1}月${date.getDate()}日`;
}
export function predictionAccuracyText(
  prediction: Prediction,
  value: Prediction["likelihood"],
): string {
  const fallback = predictionDisplayLikelihood(prediction, value);
  const accuracy = prediction.accuracy ?? fallback;
  const labels = {
    high: "高",
    fairly_high: "较高",
    medium: "中",
    fairly_low: "较低",
    low: "低",
  } as const;
  return `预测准确性${labels[accuracy]}`;
}

export function lastOpeningValue(
  prediction: Pick<Prediction, "lastRecordedAt" | "lastRecordedTimestamp">,
  now = new Date(),
): string | null {
  if (!prediction.lastRecordedAt) return null;
  if (!prediction.lastRecordedTimestamp) return prediction.lastRecordedAt;
  const date = new Date(prediction.lastRecordedTimestamp);
  if (!Number.isFinite(date.getTime())) return prediction.lastRecordedAt;
  const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const weekStart = calendarDay(now) - ((now.getDay() + 6) % 7) * 86400000;
  const dateDay = calendarDay(date);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  const label =
    dateDay >= weekStart && dateDay < weekStart + 7 * 86400000
      ? weekday
      : date.getFullYear() === now.getFullYear()
        ? `${date.getMonth() + 1}月${date.getDate()}日`
        : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  return `${label} ${hhmm(date)}`;
}
export function predictionDisplayLikelihood(
  prediction: Pick<Prediction, "probabilityKnown">,
  value: Prediction["likelihood"],
): "high" | "medium" | "low" {
  return prediction.probabilityKnown === true ? (value ?? "low") : "low";
}
function period(minute: number): string {
  const h = (((minute % 1440) + 1440) % 1440) / 60;
  return h < 6
    ? "凌晨"
    : h < 12
      ? "上午"
      : h < 18
        ? "下午"
        : h < 23
          ? "晚间"
          : "深夜";
}
function datedPeriod(label: string, value: string): string {
  return value === "晚间" && ["今天", "明天", "后天"].includes(label)
    ? `${label.slice(0, -1)}晚`
    : `${label}${value}`;
}
export function predictionTitle(
  prediction: Prediction,
  now = new Date(),
): string {
  const start = timestamp(prediction, "start"),
    windowStart = timestamp(prediction, "windowStart"),
    end = timestamp(prediction, "windowEnd");
  const from = prediction.windowStart ?? prediction.startAt ?? "",
    to = prediction.windowEnd ?? "";
  const range = `${from}–${to}`;
  const broad =
    prediction.timeGranularity === "period" ||
    (to &&
      clockMinutes(to) - clockMinutes(from) > 180 &&
      period(clockMinutes(from)) === period(clockMinutes(to)));
  if (prediction.kind === "next" && start && end) {
    const lastDate = prediction.nextDateEnd
      ? new Date(`${prediction.nextDateEnd}T00:00:00`)
      : null;
    const expiry = lastDate ? new Date(lastDate.getTime()) : end;
    if (lastDate) expiry.setMinutes(clockMinutes(to));
    if (expiry.getTime() < now.getTime()) return "暂无预测";
    const delta = start.getTime() - now.getTime();
    if (
      !lastDate &&
      delta >= 0 &&
      delta <= 30 * 60000 &&
      predictionDisplayLikelihood(prediction, prediction.likelihood) === "high"
    )
      return "预计即将开播";
    const label = dateLabel(start, now);
    if (lastDate)
      return `预计${label}或${dateLabel(lastDate, now)}${period(start.getHours() * 60)}开播`;
    if (broad)
      return `预计${datedPeriod(label, period(start.getHours() * 60))}开播`;
    if (prediction.timeGranularity === "exact")
      return `预计${label}${start.getHours() < 6 ? "凌晨 " : " "}${hhmm(start)} 开播`;
    if (prediction.timeGranularity === "quarter_hour") {
      const rounded = new Date(start);
      rounded.setMinutes(Math.round(rounded.getMinutes() / 15) * 15, 0, 0);
      return `预计${dateLabel(rounded, now)}${rounded.getHours() < 6 ? "凌晨 " : " "}${hhmm(rounded)} 左右开播`;
    }
    const rangeStart = windowStart ?? start;
    const overnight = localDate(rangeStart) !== localDate(end);
    const rangeDate = dateLabel(rangeStart, now);
    const rangeLabel =
      overnight && rangeStart.getHours() >= 18
        ? datedPeriod(rangeDate, "晚间")
        : rangeDate;
    const datedRange = `${hhmm(rangeStart)}–${overnight ? "次日 " : ""}${hhmm(end)}`;
    return `预计${rangeLabel} ${datedRange} 开播`;
  }
  const type =
    prediction.typicalDayType === "weekday"
      ? "工作日"
      : prediction.typicalDayType === "weekend"
        ? "周末"
        : "";
  if (broad)
    return `常在${type}${period(clockMinutes(prediction.startAt ?? from))}开播`;
  if (
    prediction.timeGranularity === "exact" ||
    prediction.timeGranularity === "quarter_hour"
  )
    return `常在${type}${type ? " " : ""}${(prediction.startAt ?? from).replace("次日 ", "凌晨 ")} 左右开播`;
  return `常在${type}${type ? " " : ""}${range} 开播`;
}
/** Split midnight windows into two bands on a 24-hour track. */
export function timelineBands(
  slot: Prediction["slots"][number],
): Array<Prediction["slots"][number] & { start: number; end: number }> {
  const from = clockMinutes(slot.startAt),
    to = clockMinutes(slot.endAt);
  const duration = Math.min(1440, Math.max(30, to - from));
  const start = from % 1440,
    end = start + duration;
  return end <= 1440
    ? [{ ...slot, start, end }]
    : [
        { ...slot, start, end: 1440 },
        { ...slot, start: 0, end: end - 1440 },
      ];
}
