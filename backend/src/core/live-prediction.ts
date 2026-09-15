export type PredictionConfidence = 'high' | 'medium' | 'low';
export type PredictionKind = 'unavailable' | 'observation' | 'typical' | 'next';
export type PredictionBasis = 'weekday' | 'day_type' | 'interval' | 'all';
export type PredictionTimeGranularity = 'exact' | 'quarter_hour' | 'approximate' | 'period';
export type PredictionObservationQuality = 'platform' | 'transition' | 'initial_live' | 'legacy';
export interface DetectedLiveEvent {
  detectedAt: string;
  source?: PredictionObservationQuality | 'recording';
  lowerBoundAt?: string | null;
  platformStartedAt?: string | null;
}
export interface PredictionCoverageInterval {
  startAt: string;
  endAt: string;
}
export interface LivePrediction {
  roomId: string;
  startAt: string | null;
  endAt: string | null;
  confidence: PredictionConfidence | null;
  basedOnDays: number;
  notice: string | null;
  generatedAt: string;
  kind: PredictionKind;
  basis: PredictionBasis | null;
  /** Calendar date anchoring the window; times may explicitly carry 次日. */
  nextDate: string | null;
  startTimestamp: string | null;
  windowStartTimestamp: string | null;
  windowEndTimestamp: string | null;
  sampleCount: number;
  timeGranularity: PredictionTimeGranularity | null;
  windowStart: string | null;
  windowEnd: string | null;
  expectedEndAt: string | null;
  slots: Array<{ startAt: string; endAt: string; likelihood: PredictionConfidence; probabilityKnown: boolean }>;
  todayProbability: PredictionConfidence | null;
  likelihood: PredictionConfidence | null;
  /** Uncalibrated selected-window probability, used as the calibration bucket. */
  rawLikelihood: PredictionConfidence | null;
  probabilityKnown: boolean;
  lastRecordedAt: string | null;
  lastRecordedQuality?: PredictionObservationQuality;
  nextDateEnd?: string | null;
  typicalDayType?: string | null;
  recentObservations: Array<{ time: string; quality: PredictionObservationQuality }>;
}
interface Occurrence {
  event: DetectedLiveEvent;
  estimatedAt: number;
  recordedAt: number;
  weight: number;
  quality: PredictionObservationQuality;
  uncertainty: number;
  minute: number;
  day: number;
}
interface Slot {
  start: number;
  end: number;
  representative: number;
  weight: number;
  items: Occurrence[];
}
interface Model {
  basis: PredictionBasis;
  key: number | string;
  items: Occurrence[];
  slots: Slot[];
  interval?: number;
  intervalEnd?: number;
  lastDay?: number;
}
const WINDOW_DAYS = 60;
const MIN_WINDOW = 30;
const MIN_DAYS = 2;
const MIN_SESSION_GAP = 45;
const MINUTE_MS = 60_000;
interface CoverageRange {
  start: number;
  end: number;
}

function coverageRanges(intervals: PredictionCoverageInterval[]): CoverageRange[] {
  const sorted = intervals
    .map((interval) => ({ start: Date.parse(interval.startAt), end: Date.parse(interval.endAt) }))
    .filter((v) => Number.isFinite(v.start) && Number.isFinite(v.end) && v.end >= v.start)
    .sort((a, b) => a.start - b.start);
  const merged: CoverageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}
function coversRanges(ranges: CoverageRange[], start: number, end: number): boolean {
  let lo = 0,
    hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid]!.start <= start) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && ranges[hi]!.end >= end;
}

/** Polling coverage must bracket the whole opening window, with no shutdown gaps. */
export function coversPredictionWindow(intervals: PredictionCoverageInterval[], start: number, end: number): boolean {
  return coversRanges(coverageRanges(intervals), start, end);
}

export function calculateLivePrediction(input: {
  roomId: string;
  events: DetectedLiveEvent[];
  fallbackEvents?: DetectedLiveEvent[];
  calibration?: Partial<Record<PredictionConfidence, { hits: number; total: number }>> | undefined;
  coverage?: PredictionCoverageInterval[] | undefined;
  now: number;
  generatedAt: string;
}): LivePrediction {
  const cutoffDate = new Date(input.now);
  cutoffDate.setDate(cutoffDate.getDate() - WINDOW_DAYS);
  cutoffDate.setHours(0, 0, 0, 0);
  const convert = (events: DetectedLiveEvent[]) =>
    events
      .filter((event) => Date.parse(event.detectedAt) <= input.now)
      .map(toOccurrence)
      .filter(
        (o): o is Occurrence => !!o && o.estimatedAt >= cutoffDate.getTime() && o.estimatedAt <= input.now && o.recordedAt <= input.now,
      );
  const detected = convert(input.events);
  // Recording starts can supplement unobserved dates, but never duplicate a
  // date already represented by detector evidence (first discovery may be late).
  const detectedDays = new Set(detected.map((o) => o.day));
  const fallback = convert(input.fallbackEvents ?? []).filter((o) => !detectedDays.has(o.day));
  const platformStarts = new Set<number>();
  const items = [...detected, ...fallback]
    .filter((o) => {
      if (o.quality !== 'platform') return true;
      if (platformStarts.has(o.estimatedAt)) return false;
      platformStarts.add(o.estimatedAt);
      return true;
    })
    .sort((a, b) => a.estimatedAt - b.estimatedAt);
  // Unwrap once before counting independent broadcast days or grouping weekdays.
  for (const slot of cluster(items, true)) {
    // Very early standalone openings need a previous-day anchor to retain
    // their leading margin across midnight without negative clock values.
    if (slot.items.some((o) => o.minute < MIN_WINDOW / 2) && slot.items.every((o) => o.minute < 180)) {
      for (const item of slot.items) item.minute += 1440;
    }
    for (const item of slot.items) {
      if (item.minute >= 1440) {
        const d = new Date(item.day);
        d.setDate(d.getDate() - 1);
        item.day = d.getTime();
      }
    }
  }
  const basedOnDays = distinctDays(items);
  const latest = items.reduce<Occurrence | undefined>((a, b) => (!a || b.recordedAt > a.recordedAt ? b : a), undefined);
  const base: LivePrediction = {
    roomId: input.roomId,
    startAt: null,
    endAt: null,
    confidence: null,
    basedOnDays,
    notice: null,
    generatedAt: input.generatedAt,
    kind: 'unavailable',
    basis: null,
    nextDate: null,
    startTimestamp: null,
    windowStartTimestamp: null,
    windowEndTimestamp: null,
    sampleCount: items.length,
    timeGranularity: null,
    windowStart: null,
    windowEnd: null,
    expectedEndAt: null,
    slots: [],
    todayProbability: null,
    likelihood: null,
    rawLikelihood: null,
    probabilityKnown: false,
    ...(latest ? { lastRecordedQuality: latest.quality } : {}),
    lastRecordedAt: latest ? hhmm(minuteOfDay(latest.recordedAt)) : null,
    recentObservations: items.slice(-8).map((o) => ({ time: hhmm(minuteOfDay(o.estimatedAt)), quality: o.quality })),
  };
  if (!items.length) return { ...base, notice: '检测到更多开播后显示预测' };
  if (basedOnDays < MIN_DAYS)
    return { ...base, kind: 'observation', startAt: base.lastRecordedAt, notice: '检测到不同日期的开播记录后形成预测' };

  // Unbounded first discovery says when the user saw a live room, not when
  // it opened. Preserve its observation UI but do not infer opening clocks.
  const usable = items.filter((o) => Number.isFinite(o.uncertainty) && o.uncertainty <= 360);
  if (distinctDays(usable) < MIN_DAYS) return { ...base, kind: 'observation', startAt: base.lastRecordedAt };
  const recentItems = usable.filter((o) => o.estimatedAt >= input.now - 21 * 86400000);
  const resuming =
    recentItems.length > 0 &&
    distinctDays(recentItems) < MIN_DAYS &&
    items.some((o) => o.estimatedAt < input.now - 21 * 86400000) &&
    recentItems.reduce((at, o) => Math.min(at, o.estimatedAt), input.now) -
      items.reduce((at, o) => (o.estimatedAt < input.now - 21 * 86400000 ? Math.max(at, o.estimatedAt) : at), 0) >
      21 * 86400000;
  const coverage = coverageRanges(input.coverage ?? []);
  const models = modelCandidates(usable, input.now, coverage);
  const newestUsable = usable.reduce((at, o) => Math.max(at, o.estimatedAt), 0);
  const stale = input.now - newestUsable > 21 * 86400000;
  const selected = stale ? null : selectUpcomingModel(models, input.now);
  const model = selected?.model ?? { basis: 'all' as const, key: 'all', items: usable, slots: slotsForItems(usable, input.now) };
  const slot = selected?.slot ?? dominantSlot(model.slots)!;
  const date = selected?.date;
  if (!date && distinctDays(slot.items) < MIN_DAYS) return base;
  const history = new Map<number, Occurrence[]>();
  for (const item of model.items) {
    const dayItems = history.get(item.day) ?? [];
    dayItems.push(item);
    history.set(item.day, dayItems);
  }
  const views = model.slots.map((s) => {
    const confidence = resuming ? ('low' as const) : confidenceFor(model.basis, s);
    const raw =
      date && (model.basis !== 'interval' || model.intervalEnd === model.interval)
        ? probabilityForSlot(model, s, date, coverage, history, input.now)
        : null;
    const bucket = raw ? input.calibration?.[raw] : undefined;
    const calibrated = bucket && bucket.total >= 5 ? probabilityFromRate((bucket.hits + 1) / (bucket.total + 2)) : raw;
    return { slot: s, confidence, raw, likelihood: calibrated ? lowerConfidence(calibrated, confidence) : ('low' as const) };
  });
  const view = views.find((v) => v.slot === slot)!;
  const startTimestamp = date ? atMinute(date, slot.representative) : null;
  const windowStartTimestamp = date ? atMinute(date, slot.start) : null;
  const windowEndTimestamp = date ? atMinute(date, slot.end) : null;
  const days = distinctDays(slot.items);
  const uncertainty = weightedQuantile(slot.items, 0.75, (o) => o.uncertainty);
  const spread = weightedQuantile(slot.items, 0.75, (o) => o.minute) - weightedQuantile(slot.items, 0.25, (o) => o.minute);
  const granularity: PredictionTimeGranularity =
    days >= 4 && spread <= 15 && slot.end - slot.start <= MIN_WINDOW && uncertainty <= 5
      ? 'exact'
      : days >= MIN_DAYS && slot.end - slot.start <= 60 && uncertainty <= 30
        ? 'quarter_hour'
        : slot.end - slot.start > 180 && periodKey(slot.start) === periodKey(slot.end)
          ? 'period'
          : 'approximate';
  return {
    ...base,
    kind: date ? 'next' : 'typical',
    basis: model.basis,
    nextDate: date ? localDate(date.getTime()) : null,
    nextDateEnd: selected?.dateEnd ? localDate(selected.dateEnd.getTime()) : null,
    typicalDayType:
      !date && new Set(items.map((o) => dayType(new Date(o.day).getDay()))).size === 1 ? dayType(new Date(items[0]!.day).getDay()) : null,
    startTimestamp: startTimestamp?.toISOString() ?? null,
    windowStartTimestamp: windowStartTimestamp?.toISOString() ?? null,
    windowEndTimestamp: windowEndTimestamp?.toISOString() ?? null,
    startAt: hhmm(slot.representative),
    windowStart: hhmm(slot.start),
    windowEnd: hhmm(slot.end),
    sampleCount: model.items.length,
    confidence: stale ? 'low' : view.confidence,
    timeGranularity: granularity,
    slots: views
      .sort((a, b) => b.slot.weight - a.slot.weight)
      .map((v) => ({ startAt: hhmm(v.slot.start), endAt: hhmm(v.slot.end), likelihood: v.likelihood, probabilityKnown: v.raw !== null })),
    todayProbability: startTimestamp && localDate(startTimestamp.getTime()) === localDate(input.now) && view.raw ? view.likelihood : null,
    likelihood: view.likelihood,
    rawLikelihood: view.raw,
    probabilityKnown: view.raw !== null,
    notice: null,
  };
}

function modelCandidates(items: Occurrence[], now: number, coverage: CoverageRange[]): Model[] {
  const weekdays = new Map<number, Occurrence[]>(),
    types = new Map<string, Occurrence[]>();
  for (const item of items) {
    const dow = new Date(item.day).getDay(),
      type = dayType(dow);
    const a = weekdays.get(dow) ?? [];
    a.push(item);
    weekdays.set(dow, a);
    const b = types.get(type) ?? [];
    b.push(item);
    types.set(type, b);
  }
  const models: Model[] = [];
  const weekdaySlots = new Map([...weekdays].map(([dow, group]) => [dow, slotsForItems(group, now)]));
  for (const [key, group] of weekdays)
    if (distinctDays(group) >= MIN_DAYS) models.push({ basis: 'weekday', key, items: group, slots: weekdaySlots.get(key)! });
  for (const [key, group] of types) {
    const dows = [...new Set(group.map((o) => new Date(o.day).getDay()))];
    // A broad fallback is appropriate for sparse onboarding history, or a
    // consistent habit actually observed across the complete day type.
    const established = dows.some((dow) => distinctDays(weekdays.get(dow)!) >= MIN_DAYS);
    if (distinctDays(group) < MIN_DAYS || dows.length < 2 || (established && dows.length < (key === 'weekend' ? 2 : 5))) continue;
    const slots = slotsForItems(group, now),
      main = dominantSlot(slots)!;
    if (dows.some((dow) => circularDistance(dominantSlot(weekdaySlots.get(dow)!)!.representative, main.representative) > 90)) continue;
    models.push({ basis: 'day_type', key, items: group, slots });
  }
  const cadence = intervalModel(items, now, coverage);
  if (cadence) models.push(cadence);
  return models;
}
function atCalendarOffset(date: Date, offset: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + offset);
  return d;
}
function calendarDay(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
}
function intervalModel(items: Occurrence[], now: number, coverage: CoverageRange[]): Model | null {
  const days = [...new Set(items.filter((o) => o.estimatedAt >= now - WINDOW_DAYS * 86400000).map((o) => o.day))].sort((a, b) => a - b);
  if (days.length < 4) return null;
  const gaps = days.slice(1).map((day, i) => calendarDay(day) - calendarDay(days[i]!));
  const counts = new Map<number, number>();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  const mode = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
  if (mode[0] < 2 || mode[0] > 14 || mode[0] === 7) return null;
  const near = gaps.filter((gap) => gap === mode[0] || gap === mode[0] + 1);
  if (near.length / gaps.length < 0.75 || mode[1] < 2 || gaps.slice(-3).some((gap) => gap !== mode[0] && gap !== mode[0] + 1)) return null;
  const intervalEnd = near.includes(mode[0] + 1) ? mode[0] + 1 : mode[0];
  const recent = items.filter((o) => o.day >= days[0]!);
  // A gap in discoveries is not proof of a gap in broadcasts. Require actual
  // opening evidence and monitored intervening candidate windows before dating
  // an every-N-days habit; otherwise retain a low-probability typical time.
  if (recent.some((o) => o.quality !== 'platform' && !(o.event.source === 'transition' && o.uncertainty <= 30))) return null;
  const slots = slotsForItems(recent, now);
  if (slots.length !== 1) return null;
  const slot = slots[0]!;
  const daySet = new Set(days);
  const first = calendarDay(days[0]!);
  const last = calendarDay(days[days.length - 1]!);
  for (let offset = 1; offset < last - first; offset++) {
    const date = atCalendarOffset(new Date(days[0]!), offset);
    if (daySet.has(date.getTime())) continue;
    if (!coversRanges(coverage, atMinute(date, slot.start).getTime(), atMinute(date, slot.end).getTime())) return null;
  }
  // A repeating weekly arrangement is stronger evidence than short gaps such
  // as Mon/Wed/Fri (2,2,3), which must not introduce a Sunday candidate.
  const weekdayDays = new Map<number, number>();
  for (const day of days) {
    const dow = new Date(day).getDay();
    weekdayDays.set(dow, (weekdayDays.get(dow) ?? 0) + 1);
  }
  if (mode[0] !== 14 && weekdayDays.size <= 3 && [...weekdayDays.values()].every((count) => count >= 2)) return null;
  return { basis: 'interval', key: 'interval', items: recent, slots, interval: mode[0], intervalEnd, lastDay: days[days.length - 1]! };
}
function selectUpcomingModel(models: Model[], now: number): { model: Model; date: Date; slot: Slot; dateEnd?: Date } | null {
  let best: { model: Model; date: Date; slot: Slot; start: number } | null = null;
  const multipleSessions = new Map(models.map((model) => [model, hasRecurringDailySessions(model.slots)]));
  const cadence = models.find((m) => m.basis === 'interval');
  if (cadence && cadence.lastDay !== undefined && cadence.interval) {
    let date = atCalendarOffset(new Date(cadence.lastDay), cadence.interval);
    const dateEnd = atCalendarOffset(new Date(cadence.lastDay), cadence.intervalEnd ?? cadence.interval);
    const slot = dominantSlot(cadence.slots)!;
    // A variable interval can still open on its second day, but never advance
    // beyond that range without a newly observed broadcast.
    if (atMinute(dateEnd, slot.end).getTime() >= now) {
      if (atMinute(date, slot.end).getTime() < now) date = dateEnd;
      return { model: cadence, date, slot, ...(dateEnd.getTime() > date.getTime() ? { dateEnd } : {}) };
    }
    return null;
  }
  // Yesterday can still own an active cross-midnight window.
  for (let offset = -1; offset <= 7; offset++) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const dow = date.getDay();
    const model =
      models.find((m) => m.basis === 'weekday' && m.key === dow) ?? models.find((m) => m.basis === 'day_type' && m.key === dayType(dow));
    if (!model) continue;
    const dailySessions = multipleSessions.get(model)!;
    for (const slot of offset >= 1 && !dailySessions ? [dominantSlot(model.slots)!] : model.slots) {
      const start = atMinute(date, slot.start).getTime(),
        end = atMinute(date, slot.end).getTime();
      if (end < now || distinctDays(slot.items) < MIN_DAYS) continue;
      // A completed opening is not the next session, even while its uncertainty
      // window remains active. Only proven openings consume a recurring session.
      if (slot.items.some((item) => item.day === date.getTime() && openingEvidenceInWindow(item.event, start, end) === 'hit')) continue;
      // Always select the nearest supported window; unrelated larger groups
      // cannot hide an earlier usable opening.
      if (!best || Math.max(now, start) < Math.max(now, best.start) || (start === best.start && slot.weight > best.slot.weight))
        best = { model, date, slot, start };
    }
  }
  return best;
}
function probabilityForSlot(
  model: Model,
  slot: Slot,
  target: Date,
  coverage: CoverageRange[],
  history: Map<number, Occurrence[]>,
  now: number,
): PredictionConfidence | null {
  let observed = 0,
    possible = 0;
  for (let offset = 1; offset <= WINDOW_DAYS; offset++) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const dow = date.getDay();
    const matches =
      model.basis === 'interval'
        ? !!model.interval && (calendarDay(target.getTime()) - calendarDay(date.getTime())) % model.interval === 0
        : model.basis === 'weekday'
          ? dow === target.getDay()
          : dayType(dow) === dayType(target.getDay());
    if (!matches) continue;
    // Opening evidence is not a substitute for coverage on days with no event.
    const start = atMinute(date, slot.start).getTime(),
      end = atMinute(date, slot.end).getTime();
    const evidence = (history.get(date.getTime()) ?? []).map((item) => ({
      item,
      outcome: openingEvidenceInWindow(item.event, start, end),
    }));
    // Once an opening is proven, monitoring after it is unnecessary. Automatic
    // recording deliberately suspends polling, so require coverage up to the
    // detection, rather than incorrectly discarding every recorded broadcast.
    const hit = evidence.some(
      ({ item, outcome }) => outcome === 'hit' && coversRanges(coverage, start, Math.min(end, Date.parse(item.event.detectedAt))),
    );
    if (!hit && (evidence.some((v) => v.outcome === 'unknown') || !coversRanges(coverage, start, end))) continue;
    possible++;
    if (hit) observed++;
  }
  return possible >= MIN_DAYS ? probabilityFromRate(observed / possible) : null;
}
function periodKey(minute: number): number {
  const h = (minute % 1440) / 60;
  return h < 6 ? 0 : h < 12 ? 1 : h < 18 ? 2 : h < 23 ? 3 : 4;
}
function slotsForItems(items: Occurrence[], now: number): Slot[] {
  let slots = cluster(items);
  if (distinctDays(items) <= 3 && slots.length > 1 && !hasRecurringDailySessions(slots)) {
    const min = items.reduce((at, o) => Math.min(at, o.minute), Infinity);
    const max = items.reduce((at, o) => Math.max(at, o.minute), -Infinity);
    if (max - min <= 300 && periodKey(min) === periodKey(max)) {
      return [
        {
          start: Math.max(0, min - 15),
          end: max + 15,
          representative: weightedQuantile(items, 0.5, (o) => o.minute),
          weight: slots.reduce((sum, s) => sum + s.weight, 0),
          items,
        },
      ];
    }
  }
  // Three recent independent dates can reveal a modest schedule shift that
  // would otherwise remain buried inside the old, wider cluster.
  const recentDays = [...new Set(items.map((o) => o.day))].sort((a, b) => b - a).slice(0, 3);
  if (recentDays.length === 3 && !hasRecurringDailySessions(slots)) {
    const dates = new Set(recentDays);
    const latest = cluster(items.filter((o) => dates.has(o.day)));
    const fresh = dominantSlot(latest)!,
      old = dominantSlot(slots)!;
    if (
      latest.length === 1 &&
      distinctDays(fresh.items) === 3 &&
      fresh.end - fresh.start <= 60 &&
      circularDistance(fresh.representative, old.representative) >= 60 &&
      weightedQuantile(fresh.items, 0.75, (o) => o.uncertainty) <= 30
    ) {
      const match = slots.reduce((a, b) =>
        circularDistance(a.representative, fresh.representative) < circularDistance(b.representative, fresh.representative) ? a : b,
      );
      slots = slots.map((slot) => (slot === match ? { ...fresh, weight: Math.max(fresh.weight, old.weight * 1.05) } : slot));
    }
  }
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 21);
  cutoff.setHours(0, 0, 0, 0);
  const recent = items.filter((o) => o.estimatedAt >= cutoff.getTime());
  if (distinctDays(recent) < 3 || slots.length < 2) return slots;
  const recentSlots = cluster(recent),
    promoted = dominantSlot(recentSlots)!,
    old = dominantSlot(slots)!;
  if (
    distinctDays(promoted.items) < 3 ||
    promoted.weight / recentSlots.reduce((s, v) => s + v.weight, 0) < 0.6 ||
    circularDistance(promoted.representative, old.representative) < 90
  )
    return slots;
  const match = slots.reduce((a, b) =>
    circularDistance(a.representative, promoted.representative) < circularDistance(b.representative, promoted.representative) ? a : b,
  );
  if (circularDistance(match.representative, promoted.representative) <= 90) match.weight = Math.max(match.weight, old.weight * 1.05);
  return slots;
}
function cluster(items: Occurrence[], unwrap = false): Slot[] {
  const sorted = [...items].sort((a, b) => a.minute - b.minute);
  if (!sorted.length) return [];
  const groups: Occurrence[][] = [[sorted[0]!]];
  for (const item of sorted.slice(1)) {
    const current = groups[groups.length - 1]!;
    // Limit total cluster span as well as adjacent gaps: a chain of observations
    // must not turn a whole day into one concentrated period.
    if (item.minute - current[current.length - 1]!.minute > 180 || item.minute - current[0]!.minute > 180) groups.push([item]);
    else current.push(item);
  }
  if (
    unwrap &&
    groups.length > 1 &&
    sorted[sorted.length - 1]!.minute < 1440 &&
    sorted[0]!.minute + 1440 - sorted[sorted.length - 1]!.minute <= 180 &&
    groups[0]![groups[0]!.length - 1]!.minute + 1440 - groups[groups.length - 1]![0]!.minute <= 180
  ) {
    const first = groups.shift()!;
    for (const item of first) item.minute += 1440;
    groups[groups.length - 1]!.push(...first);
  }
  // Midnight normalization must finish before comparing broadcast dates.
  // Smaller gaps split only when both sides recur on the same independent days.
  const sessions = unwrap ? groups : groups.flatMap(splitRecurringSessions);
  return sessions.map((rawGroup) => {
    // Each date contributes at most one date's evidence to a slot, regardless
    // of reconnects or repeated discoveries. Preserve distinct daily sessions.
    const totals = new Map<number, { sum: number; max: number }>();
    for (const item of rawGroup) {
      const v = totals.get(item.day) ?? { sum: 0, max: 0 };
      v.sum += item.weight;
      v.max = Math.max(v.max, item.weight);
      totals.set(item.day, v);
    }
    const group = unwrap ? rawGroup : rawGroup.map((o) => ({ ...o, weight: (o.weight * totals.get(o.day)!.max) / totals.get(o.day)!.sum }));
    const uncertainty =
      !unwrap && distinctDays(group) <= 3
        ? group.reduce((value, o) => Math.max(value, o.uncertainty), 0)
        : weightedQuantile(group, 0.75, (o) => o.uncertainty);
    const padding = Number.isFinite(uncertainty) ? Math.min(360, uncertainty) / 2 : 90;
    const days = distinctDays(group);
    const sparse = !unwrap && days >= MIN_DAYS && days <= 3;
    const min = group.reduce((v, o) => Math.min(v, o.minute), Infinity);
    const max = group.reduce((v, o) => Math.max(v, o.minute), -Infinity);
    // Small jitter keeps the narrow 30-minute window; substantial sparse
    // variation retains the observed bounds plus a capped 15–30 minute margin.
    const sparsePadding = sparse && max - min > 30 ? Math.min(30, Math.max(15, (max - min) / 4)) : 0;
    const lower = (sparse ? min : weightedQuantile(group, 0.25, (o) => o.minute)) - Math.max(padding, sparsePadding);
    const upper = (sparse ? max : weightedQuantile(group, 0.75, (o) => o.minute)) + Math.max(padding, sparsePadding);
    const extra = Math.max(0, MIN_WINDOW - (upper - lower)) / 2;
    // Expand narrow windows on both sides, preserving the existing uncertainty
    // padding of wider observations. At midnight keep the full minimum width.
    const start = Math.max(0, lower - extra);
    return {
      start: Math.round(start),
      end: Math.round(Math.max(upper + extra, start + MIN_WINDOW)),
      representative: weightedQuantile(group, 0.5, (o) => o.minute),
      weight: group.reduce((s, o) => s + o.weight, 0),
      items: group,
    };
  });
}
function splitRecurringSessions(group: Occurrence[]): Occurrence[][] {
  let boundary = -1,
    largestGap = 0;
  for (let i = 1; i < group.length; i++) {
    const gap = group[i]!.minute - group[i - 1]!.minute;
    if (gap < MIN_SESSION_GAP || gap <= largestGap) continue;
    const leftDays = new Set(
      group
        .slice(0, i)
        .filter((item) => item.uncertainty <= 30)
        .map((item) => item.day),
    );
    const rightDays = new Set(
      group
        .slice(i)
        .filter((item) => item.uncertainty <= 30)
        .map((item) => item.day),
    );
    let shared = 0;
    for (const day of leftDays) if (rightDays.has(day)) shared++;
    if (shared >= MIN_DAYS) {
      boundary = i;
      largestGap = gap;
    }
  }
  if (boundary < 0) return [group];
  return [...splitRecurringSessions(group.slice(0, boundary)), ...splitRecurringSessions(group.slice(boundary))];
}
function hasRecurringDailySessions(slots: Slot[]): boolean {
  const days = new Map<number, Set<number>>();
  slots.forEach((slot, index) => {
    for (const item of slot.items) {
      if (item.uncertainty > 30) continue;
      const sessions = days.get(item.day) ?? new Set<number>();
      sessions.add(index);
      days.set(item.day, sessions);
    }
  });
  const pairCounts = new Map<string, number>();
  for (const sessions of days.values()) {
    const indices = [...sessions];
    for (let a = 0; a < indices.length; a++)
      for (let b = a + 1; b < indices.length; b++) {
        const pair = `${indices[a]}:${indices[b]}`,
          count = (pairCounts.get(pair) ?? 0) + 1;
        if (count >= MIN_DAYS) return true;
        pairCounts.set(pair, count);
      }
  }
  return false;
}
function confidenceFor(basis: PredictionBasis, slot: Slot): PredictionConfidence {
  const days = distinctDays(slot.items),
    quality = slot.items.reduce((s, o) => s + o.weight, 0) / slot.items.length;
  if (basis !== 'all' && days >= 6 && slot.end - slot.start <= 60 && quality >= 0.7) return 'high';
  if (days >= 4 && slot.end - slot.start <= 120 && quality >= 0.45) return 'medium';
  return 'low';
}
function weightedQuantile(items: Occurrence[], q: number, value: (o: Occurrence) => number): number {
  const sorted = [...items].sort((a, b) => value(a) - value(b)),
    threshold = sorted.reduce((s, o) => s + o.weight, 0) * q;
  let sum = 0;
  for (const item of sorted) {
    sum += item.weight;
    if (sum >= threshold) return value(item);
  }
  return value(sorted[sorted.length - 1]!);
}
function distinctDays(items: Occurrence[]): number {
  return new Set(items.map((o) => o.day)).size;
}
function dominantSlot(slots: Slot[]): Slot | undefined {
  return slots.reduce<Slot | undefined>((a, b) => (!a || b.weight > a.weight ? b : a), undefined);
}
function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}
function dayType(dow: number): string {
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}
function probabilityFromRate(rate: number): PredictionConfidence {
  return rate >= 0.5 ? 'high' : rate >= 0.25 ? 'medium' : 'low';
}
function lowerConfidence(a: PredictionConfidence, b: PredictionConfidence): PredictionConfidence {
  const order = { low: 0, medium: 1, high: 2 };
  return order[a] <= order[b] ? a : b;
}
function toOccurrence(event: DetectedLiveEvent): Occurrence | null {
  const detectedAt = Date.parse(event.detectedAt);
  if (!Number.isFinite(detectedAt)) return null;
  const platform = event.platformStartedAt ? Date.parse(event.platformStartedAt) : NaN;
  const lower = event.lowerBoundAt ? Date.parse(event.lowerBoundAt) : NaN;
  const validLower = Number.isFinite(lower) && lower <= detectedAt && event.source !== 'initial_live';
  const interval = validLower ? (detectedAt - lower) / MINUTE_MS : Infinity;
  const platformValid =
    event.source === 'platform' && Number.isFinite(platform) && platform <= detectedAt && (!validLower || platform >= lower);
  const estimatedAt = platformValid ? platform : validLower && interval <= 360 ? lower + (detectedAt - lower) / 2 : detectedAt;
  const quality: PredictionObservationQuality = platformValid
    ? 'platform'
    : event.source === 'transition'
      ? 'transition'
      : event.source === 'initial_live'
        ? 'initial_live'
        : 'legacy';
  // Old detector times retain approximate usefulness; missing bounds never
  // establish minute precision. Recording starts and first discovery are weaker.
  const uncertainty = platformValid
    ? 0
    : event.source === 'recording'
      ? 90
      : quality === 'legacy'
        ? 30
        : quality === 'initial_live'
          ? Infinity
          : interval;
  const weight = platformValid
    ? 1
    : (quality === 'transition' ? 1 : quality === 'initial_live' ? 0.4 : event.source === 'recording' ? 0.3 : 0.8) *
      (interval <= 120 || quality === 'legacy' ? 1 : interval <= 360 ? 0.7 : 0.45);
  const day = new Date(estimatedAt);
  day.setHours(0, 0, 0, 0);
  return {
    event,
    estimatedAt,
    recordedAt: platformValid ? platform : detectedAt,
    weight,
    quality,
    uncertainty,
    minute: minuteOfDay(estimatedAt),
    day: day.getTime(),
  };
}
/** Only a platform time or a fully contained transition interval proves a hit. */
export function openingEvidenceInWindow(event: DetectedLiveEvent, start: number, end: number): 'hit' | 'outside' | 'unknown' {
  const occurrence = toOccurrence(event);
  if (!occurrence) return 'unknown';
  if (occurrence.quality === 'platform') return occurrence.estimatedAt >= start && occurrence.estimatedAt <= end ? 'hit' : 'outside';
  const upper = Date.parse(event.detectedAt),
    lower = event.lowerBoundAt ? Date.parse(event.lowerBoundAt) : NaN;
  if (event.source === 'transition' && Number.isFinite(lower) && lower <= upper) {
    if (upper < start || lower > end) return 'outside';
    return lower >= start && upper <= end ? 'hit' : 'unknown';
  }
  return upper < start ? 'outside' : 'unknown';
}
export function recordingFallbackEvents(recordings: Array<{ startedAt: string; streamSessionId?: string | null }>): DetectedLiveEvent[] {
  const seen = new Set<string>();
  return [...recordings]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .flatMap((r) => {
      const at = Date.parse(r.startedAt);
      if (!Number.isFinite(at)) return [];
      const key = r.streamSessionId?.trim() || `day:${localDate(at)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ detectedAt: r.startedAt, source: 'recording' as const }];
    });
}
function minuteOfDay(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}
function hhmm(minutes: number): string {
  const n = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${minutes >= 1440 ? '次日 ' : ''}${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function atMinute(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setMinutes(Math.round(minutes), 0, 0);
  return d;
}
function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
