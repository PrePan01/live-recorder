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
  const nowDay = calendarDay(now);
  const dateDay = calendarDay(date);
  const dayOffset = (dateDay - nowDay) / 86400000;
  const weekStart = nowDay - ((now.getDay() + 6) % 7) * 86400000;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  // 日期说法与预测文案统一：近三天用相对日，本周内用星期，更远用日历日。
  const label =
    dayOffset === 0
      ? "今天"
      : dayOffset === -1
        ? "昨天"
        : dayOffset === -2
          ? "前天"
          : dateDay >= weekStart && dateDay < weekStart + 7 * 86400000
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
/**
 * 标签颜色的档位。刻意与详情里那句「预测准确性」同源，否则会出现
 * 颜色说高、点开却写低的自相矛盾。缺少 accuracy 的旧响应仍走原口径。
 */
export function predictionDisplayLevel(
  prediction: Pick<Prediction, "accuracy" | "probabilityKnown">,
  value: Prediction["likelihood"],
): "high" | "medium" | "low" {
  switch (prediction.accuracy) {
    case "high":
    case "fairly_high":
      return "high";
    case "medium":
      return "medium";
    case "fairly_low":
    case "low":
      return "low";
    default:
      return predictionDisplayLikelihood(prediction, value);
  }
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
type PredictionTone = "firm" | "moderate" | "tentative";
/**
 * 把握词池：句式开头那个词由样本量决定，见过越多天说法越笃定。
 * 刻意不看时间窗口宽窄——时间不准由粒度说法承担（给区间或时段），
 * 不该表现成"不了解这个主播"，否则会出现"偶尔在 19:00 开播"配"预测准确性高"。
 */
const DATED_LEAD: Record<PredictionTone, string> = {
  firm: "预计",
  moderate: "大概",
  tentative: "可能",
};
const HABIT_LEAD: Record<PredictionTone, string> = {
  firm: "常在",
  moderate: "一般",
  tentative: "偶尔在",
};
/**
 * 把握档直接吃后端的展示准确性——它已经不掺时间窗口宽窄，所以措辞、颜色、
 * 详情里的「预测准确性」三处共用同一个口径，不会互相打脸。
 * 刻意不吃 probabilityKnown：那是"这个概率算出来了没有"，不该把说法拉低。
 * 旧响应没有 accuracy 时退回按样本天数分档。
 */
function toneFor(prediction: Prediction): PredictionTone {
  switch (prediction.accuracy) {
    case "high":
    case "fairly_high":
      return "firm";
    case "medium":
      return "moderate";
    case "fairly_low":
    case "low":
      return "tentative";
    default: {
      const days = prediction.basedOnDays ?? 0;
      if (days >= 4) return "firm";
      return days >= 3 ? "moderate" : "tentative";
    }
  }
}
/** 时段在给定基准日上的起止；"次日 HH:mm" 会自然滚到第二天。 */
function slotWindowOn(
  day: Date,
  slot: Prediction["slots"][number],
): { start: Date; end: Date } {
  const base = new Date(day);
  base.setHours(0, 0, 0, 0);
  const start = new Date(base);
  start.setMinutes(clockMinutes(slot.startAt), 0, 0);
  const end = new Date(base);
  end.setMinutes(clockMinutes(slot.endAt), 0, 0);
  if (end.getTime() < start.getTime()) end.setDate(end.getDate() + 1);
  return { start, end };
}
/**
 * 多个开播时段时，挑出还没过、且最近的那一场；都过了才顺延到次日。
 * 窗口已经开始但没结束的不算过——主播可能就在这会儿开播，跳过反而漏掉最近一次。
 */
function upcomingSlot(
  slots: Prediction["slots"],
  anchor: Date,
  now: Date,
  allowNextDay: boolean,
): { slot: Prediction["slots"][number]; start: Date; end: Date } | null {
  for (const offset of allowNextDay ? [0, 1] : [0]) {
    const day = new Date(anchor);
    day.setDate(day.getDate() + offset);
    const picked = slots
      .map((slot) => ({ slot, ...slotWindowOn(day, slot) }))
      .filter(({ end }) => end.getTime() >= now.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    if (picked) return picked;
  }
  return null;
}
/**
 * 多时段时不再罗列"有时…有时…"，而是直接说出下一场：
 * 复用"有日期"那套句式渲染挑中的时段，避免两套模板各自漂移。
 */
function upcomingSlotTitle(prediction: Prediction, now: Date): string | null {
  if (prediction.slots.length < 2 || prediction.nextDateEnd) return null;
  const anchor = prediction.nextDate
    ? new Date(`${prediction.nextDate}T00:00:00`)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 已带日期的预测由后端决定日期，不在这里凭空顺延到次日。
  const picked = upcomingSlot(
    prediction.slots,
    anchor,
    now,
    prediction.kind === "typical",
  );
  if (!picked) return null;
  // 窗口已经开始时改说区间，免得把"已经开播的时段"写成未来的钟点。
  const started = picked.start.getTime() < now.getTime();
  return predictionTitle(
    {
      ...prediction,
      kind: "next",
      // 清空时段：有日期那套句式不读它，也避免再进一次挑选。
      slots: [],
      nextDate: localDate(picked.start),
      nextDateEnd: null,
      startAt: picked.slot.startAt,
      windowStart: picked.slot.startAt,
      windowEnd: picked.slot.endAt,
      timeGranularity: started ? "approximate" : prediction.timeGranularity,
      startTimestamp: picked.start.toISOString(),
      windowStartTimestamp: picked.start.toISOString(),
      windowEndTimestamp: picked.end.toISOString(),
    },
    now,
  );
}
export function predictionTitle(
  prediction: Prediction,
  now = new Date(),
): string {
  const upcoming = upcomingSlotTitle(prediction, now);
  if (upcoming) return upcoming;
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
  const tone = toneFor(prediction);
  if (prediction.kind === "next" && start && end) {
    const lead = DATED_LEAD[tone];
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
      return `${lead}${label}或${dateLabel(lastDate, now)}${period(start.getHours() * 60)}开播`;
    if (broad)
      return `${lead}${datedPeriod(label, period(start.getHours() * 60))}开播`;
    if (prediction.timeGranularity === "exact")
      return `${lead}${label}${start.getHours() < 6 ? "凌晨 " : " "}${hhmm(start)} 开播`;
    if (prediction.timeGranularity === "quarter_hour") {
      const rounded = new Date(start);
      rounded.setMinutes(Math.round(rounded.getMinutes() / 15) * 15, 0, 0);
      return `${lead}${dateLabel(rounded, now)}${rounded.getHours() < 6 ? "凌晨 " : " "}${hhmm(rounded)} 左右开播`;
    }
    const rangeStart = windowStart ?? start;
    const overnight = localDate(rangeStart) !== localDate(end);
    const rangeDate = dateLabel(rangeStart, now);
    const rangeLabel =
      overnight && rangeStart.getHours() >= 18
        ? datedPeriod(rangeDate, "晚间")
        : rangeDate;
    const datedRange = `${hhmm(rangeStart)}–${overnight ? "次日 " : ""}${hhmm(end)}`;
    return `${lead}${rangeLabel} ${datedRange} 开播`;
  }
  const type =
    prediction.typicalDayType === "weekday"
      ? "工作日"
      : prediction.typicalDayType === "weekend"
        ? "周末"
        : "";
  const habit = HABIT_LEAD[tone];
  if (broad)
    return `${habit}${type}${period(clockMinutes(prediction.startAt ?? from))}开播`;
  if (
    prediction.timeGranularity === "exact" ||
    prediction.timeGranularity === "quarter_hour"
  ) {
    // 样本足且时间窗口很窄时才敢说"准时"；带星期几前缀时退回常规把握词。
    const precise =
      prediction.timeGranularity === "exact" && tone === "firm" && !type;
    const word = precise ? "准时" : habit;
    const clock = (prediction.startAt ?? from).replace("次日 ", "凌晨 ");
    return `${word}${type} ${clock}${precise ? " " : " 左右"}开播`;
  }
  return `${habit}${type} ${range} 开播`;
}
/** 预测窗口的钟点说法，如 19:00–21:00、20:00、23:00–次日 01:00。 */
function windowClockText(prediction: Prediction): string | null {
  const from = prediction.windowStart ?? prediction.startAt;
  const to = prediction.windowEnd;
  if (!from) return null;
  return !to || to === from ? from : `${from}–${to}`;
}
/** 去掉标签开头的把握词与结尾的"开播"，作为带日期的钟点说法。 */
function titleClockText(prediction: Prediction, now: Date): string | null {
  const leads = [...Object.values(DATED_LEAD), ...Object.values(HABIT_LEAD), "准时"];
  const stripped = predictionTitle(prediction, now)
    .replace(new RegExp(`^(${leads.join("|")})`), "")
    .replace(/开播$/, "")
    .trim();
  if (!stripped || stripped === "即将" || stripped === "暂无预测") return null;
  return stripped;
}
/**
 * 距预测窗口起点还有多久的粗档说法，只分四档、不做假精度。
 * 跨天或窗口已过时返回 null —— 否则"还要等一小时"会说谎。
 */
export function predictionCountdownText(
  prediction: Prediction,
  now = new Date(),
): string | null {
  const windowStart =
    timestamp(prediction, "windowStart") ?? timestamp(prediction, "start");
  if (!windowStart || localDate(windowStart) !== localDate(now)) return null;
  const minutes = (windowStart.getTime() - now.getTime()) / 60000;
  if (minutes < 0) return null;
  const vague = toneFor(prediction) === "tentative";
  const prefix = vague ? "可能还要等" : "大约还要等";
  if (minutes <= 30) return "马上开播";
  if (minutes <= 50) return `${prefix}半小时`;
  if (minutes <= 100) return `${prefix}一小时`;
  if (minutes <= 240) return `${prefix}两三小时`;
  return null;
}
/**
 * 详情里「预计开播」那行的值：同一天且窗口未过时给"时长 + 钟点"，
 * 否则回退成带日期的钟点说法。放在详情里也规避了标签跳字的问题。
 */
export function predictionOpeningDetail(
  prediction: Prediction,
  now = new Date(),
): string | null {
  const countdown = predictionCountdownText(prediction, now);
  if (countdown) {
    const clock =
      countdown === "马上开播"
        ? prediction.windowStart ?? prediction.startAt
        : windowClockText(prediction);
    return clock ? `${countdown} · ${clock}` : countdown;
  }
  return titleClockText(prediction, now);
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
