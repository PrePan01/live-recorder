export type PredictionConfidence = 'high' | 'medium' | 'low';
export type PredictionKind = 'unavailable' | 'observation' | 'typical' | 'next';
export type PredictionBasis = 'weekday' | 'day_type' | 'all';
export type PredictionTimeGranularity = 'exact' | 'approximate' | 'period';
export type PredictionObservationQuality = 'platform' | 'transition' | 'initial_live' | 'legacy';

export interface DetectedLiveEvent {
  detectedAt: string;
  /** Backward-compatible: events written before schema v26 have no source. */
  source?: 'platform' | 'transition' | 'initial_live' | 'legacy' | 'recording';
  /** The opening happened after this time and no later than detectedAt. */
  lowerBoundAt?: string | null;
  /** A validated real start time returned by the platform for this broadcast. */
  platformStartedAt?: string | null;
}

export interface LivePrediction {
  roomId: string;
  /** Existing fields retained for API consumers. startAt is the representative detected opening time. */
  startAt: string | null;
  endAt: string | null;
  confidence: PredictionConfidence | null;
  basedOnDays: number;
  notice: string | null;
  generatedAt: string;
  kind: PredictionKind;
  basis: PredictionBasis | null;
  nextDate: string | null;
  sampleCount: number;
  timeGranularity: PredictionTimeGranularity | null;
  windowStart: string | null;
  windowEnd: string | null;
  expectedEndAt: string | null;
  /** Slots are ordered by their relative opening likelihood, highest first. */
  slots: Array<{ startAt: string; endAt: string; likelihood: PredictionConfidence }>;
  /** Observed likelihood of an opening on the current weekday/day type. */
  todayProbability: PredictionConfidence | null;
  /** Relative likelihood of the time slot selected for display. */
  likelihood: PredictionConfidence | null;
  /** Latest recorded opening time, for display before a prediction can be formed. */
  lastRecordedAt: string | null;
  /** A compact, local-only trace for the prediction popover; newest observations only. */
  recentObservations: Array<{ time: string; quality: PredictionObservationQuality }>;
}

interface LiveOccurrence {
  estimatedAt: number;
  recordedAt: number;
  weight: number;
  platformTimed: boolean;
  quality: PredictionObservationQuality;
}

interface Model {
  basis: PredictionBasis;
  occurrences: LiveOccurrence[];
}

interface TimeSlot {
  start: number;
  end: number;
  representative: number;
  wrapsMidnight: boolean;
  weight: number;
  platformWeight: number;
  count: number;
}

const WINDOW_DAYS = 60;
const MIN_MODEL_SAMPLES = 3;

/**
 * Calculates a display-oriented prediction from persisted live observations only.
 * An initially-live discovery is useful evidence, but carries less weight than a
 * confirmed offline-to-live transition and uses its known time interval midpoint.
 */
export function calculateLivePrediction(input: {
  roomId: string;
  events: DetectedLiveEvent[];
  /** Legacy recording starts are used only while no detector observations exist. */
  fallbackEvents?: DetectedLiveEvent[];
  calibration?: Partial<Record<PredictionConfidence, { hits: number; total: number }>> | undefined;
  now: number;
  generatedAt: string;
}): LivePrediction {
  const cutoff = input.now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const observations = input.events.length > 0 ? input.events : input.fallbackEvents ?? [];
  const occurrences = observations
    .map(toOccurrence)
    .filter((occurrence): occurrence is LiveOccurrence => occurrence !== null && occurrence.estimatedAt >= cutoff)
    .sort((a, b) => a.estimatedAt - b.estimatedAt);
  const basedOnDays = new Set(occurrences.map((occurrence) => localDate(occurrence.estimatedAt))).size;
  const lastRecordedAt = occurrences.length > 0
    ? hhmmFromMinutes(minuteOfDay(occurrences[occurrences.length - 1]!.recordedAt))
    : null;
  const recentObservations = occurrences.slice(-8).map((occurrence) => ({
    time: hhmmFromMinutes(minuteOfDay(occurrence.estimatedAt)),
    quality: occurrence.quality,
  }));
  const base = (overrides: Partial<LivePrediction>): LivePrediction => ({
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
    sampleCount: 0,
    timeGranularity: null,
    windowStart: null,
    windowEnd: null,
    expectedEndAt: null,
    slots: [],
    todayProbability: null,
    likelihood: null,
    lastRecordedAt,
    recentObservations,
    ...overrides,
  });

  if (occurrences.length === 0) return base({ notice: '检测到更多开播后显示预测' });
  if (occurrences.length < MIN_MODEL_SAMPLES) {
    return base({
      kind: 'observation',
      // This is intentionally the latest observed opening, not a predicted median.
      startAt: lastRecordedAt,
      sampleCount: occurrences.length,
      notice: occurrences.length === 1 ? '基于最近一次开播检测' : `基于本机近 ${occurrences.length} 次开播检测`,
    });
  }

  const models = modelCandidates(occurrences);
  const selected = selectUpcomingModel(models, input.now);
  const todayProbability = probabilityForToday(models, input.now, input.calibration);
  if (selected) return predictionForModel(base, selected.model, selected.date, selected.slot, todayProbability, input.now);
  return predictionForModel(base, { basis: 'all', occurrences }, null, undefined, todayProbability, input.now);
}

function modelCandidates(occurrences: LiveOccurrence[]): Model[] {
  const weekday = new Map<number, LiveOccurrence[]>();
  const dayType = new Map<'weekday' | 'weekend', LiveOccurrence[]>();
  for (const occurrence of occurrences) {
    const date = new Date(occurrence.estimatedAt);
    const dow = date.getDay();
    const type = dow === 0 || dow === 6 ? 'weekend' : 'weekday';
    weekday.set(dow, [...(weekday.get(dow) ?? []), occurrence]);
    dayType.set(type, [...(dayType.get(type) ?? []), occurrence]);
  }
  // Keep a model only when the history actually supports that grouping.
  return [
    ...[...weekday.values()].filter((items) => items.length >= MIN_MODEL_SAMPLES).map((items) => ({ basis: 'weekday' as const, occurrences: items })),
    ...[...dayType.values()].filter((items) => items.length >= MIN_MODEL_SAMPLES).map((items) => ({ basis: 'day_type' as const, occurrences: items })),
  ];
}

function selectUpcomingModel(models: Model[], now: number): { model: Model; date: Date; slot: TimeSlot } | null {
  // A specific weekday is more meaningful than a nearer, broad weekend/workday guess.
  for (const basis of ['weekday', 'day_type'] as const) {
    for (let offset = 0; offset <= 7; offset += 1) {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + offset);
      const dow = date.getDay();
      const type = dow === 0 || dow === 6 ? 'weekend' : 'weekday';
      const model = modelForDate(models, basis, dow, type);
      if (!model) continue;
      const slots = slotsForModel(model, now);
      const nowMinutes = offset === 0 ? minuteOfDay(now) : -1;
      // For today, surface the nearest habitual period rather than a verbose
      // ranked list of all periods. Future dates retain the first opening slot.
      const slot = offset === 0 ? closestSlot(slots, nowMinutes) : dominantSlot(slots);
      if (slot) return { model, date, slot };
    }
  }
  return null;
}

function predictionForModel(base: (overrides: Partial<LivePrediction>) => LivePrediction, model: Model, nextDate: Date | null, selectedSlot: TimeSlot | undefined, todayProbability: PredictionConfidence | null, now: number): LivePrediction {
  const slots = slotsForModel(model, now);
  const slot = selectedSlot ?? slots[0]!;
  const representativeStart = Math.round(slot.representative);
  const windowWidth = slot.end - slot.start;
  const confidence = confidenceFor(model.basis, model.occurrences.length, windowWidth, average(model.occurrences.map((occurrence) => occurrence.weight)));
  // A precise minute is meaningful only for a platform-reported start time or a
  // high-confidence recurring pattern. Approximate display is rounded to
  // 15-minute intervals by the UI, rather than exposing a false minute precision.
  const granularity: PredictionTimeGranularity = slot.platformWeight > 0 || confidence === 'high'
    ? 'exact'
    : 'approximate';
  const windowStart = Math.round(slot.start);
  const windowEnd = Math.max(Math.round(slot.end), windowStart + 20);
  const totalSlotWeight = slots.reduce((sum, item) => sum + item.weight, 0);
  const likelihood = probabilityFromRate(totalSlotWeight > 0 ? slot.weight / totalSlotWeight : 0);
  const slotViews = slots
    .map((item) => ({
      startAt: hhmmWithNextDay(item.start),
      endAt: hhmmWithNextDay(Math.max(item.end, item.start + 20)),
      likelihood: probabilityFromRate(totalSlotWeight > 0 ? item.weight / totalSlotWeight : 0),
      weight: item.weight,
    }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight: _weight, ...item }) => item);
  return base({
    kind: nextDate ? 'next' : 'typical',
    basis: model.basis,
    nextDate: nextDate ? localDate(nextDate.getTime()) : null,
    startAt: hhmmFromMinutes(representativeStart),
    endAt: null,
    confidence,
    sampleCount: model.occurrences.length,
    timeGranularity: granularity,
    windowStart: hhmmFromMinutes(windowStart),
    windowEnd: hhmmWithNextDay(windowEnd),
    expectedEndAt: null,
    slots: slotViews,
    todayProbability,
    likelihood,
  });
}

function modelForDate(models: Model[], basis: Exclude<PredictionBasis, 'all'>, dow: number, type: 'weekday' | 'weekend'): Model | undefined {
  return models.find((item) => item.basis === basis && (basis === 'weekday'
    ? new Date(item.occurrences[0]!.estimatedAt).getDay() === dow
    : (new Date(item.occurrences[0]!.estimatedAt).getDay() === 0 || new Date(item.occurrences[0]!.estimatedAt).getDay() === 6 ? 'weekend' : 'weekday') === type));
}

function closestSlot(slots: TimeSlot[], nowMinutes: number): TimeSlot | undefined {
  return slots.reduce<TimeSlot | undefined>((closest, slot) => {
    const distance = Math.abs(slot.representative - nowMinutes);
    const closestDistance = closest ? Math.abs(closest.representative - nowMinutes) : Number.POSITIVE_INFINITY;
    return distance < closestDistance ? slot : closest;
  }, undefined);
}

function dominantSlot(slots: TimeSlot[]): TimeSlot | undefined {
  return slots.reduce<TimeSlot | undefined>((dominant, slot) => !dominant || slot.weight > dominant.weight ? slot : dominant, undefined);
}

/**
 * A recent, concentrated shift may promote a new habitual opening time, but
 * only after enough evidence has accumulated. The older slot remains in the
 * timeline and naturally regains priority if the recent pattern fades.
 */
function slotsForModel(model: Model, now: number): TimeSlot[] {
  const slots = clusterSlots(model.occurrences.map((occurrence) => ({
    value: minuteOfDay(occurrence.estimatedAt), weight: occurrence.weight, platformTimed: occurrence.platformTimed,
  })));
  const recentCutoff = now - 21 * 24 * 60 * 60 * 1_000;
  const recent = model.occurrences.filter((occurrence) => occurrence.estimatedAt >= recentCutoff);
  if (recent.length < 3 || slots.length < 2) return slots;
  const recentSlots = clusterSlots(recent.map((occurrence) => ({
    value: minuteOfDay(occurrence.estimatedAt), weight: occurrence.weight, platformTimed: occurrence.platformTimed,
  })));
  const recentDominant = dominantSlot(recentSlots);
  const longDominant = dominantSlot(slots);
  if (!recentDominant || !longDominant || recentDominant.count < 3) return slots;
  const recentWeight = recentSlots.reduce((sum, slot) => sum + slot.weight, 0);
  if (recentWeight <= 0 || recentDominant.weight / recentWeight < 0.6 || circularMinuteDistance(recentDominant.representative, longDominant.representative) < 90) return slots;
  const promoted = closestSlot(slots, recentDominant.representative);
  if (!promoted || circularMinuteDistance(promoted.representative, recentDominant.representative) > 90) return slots;
  // Give a verified new habit a slight lead, rather than replacing older data.
  return slots.map((slot) => slot === promoted ? { ...slot, weight: Math.max(slot.weight, longDominant.weight * 1.05) } : slot);
}

function circularMinuteDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 1440;
  return Math.min(raw, 1440 - raw);
}

function probabilityForToday(models: Model[], now: number, calibration?: Partial<Record<PredictionConfidence, { hits: number; total: number }>>): PredictionConfidence | null {
  const date = new Date(now);
  const dow = date.getDay();
  const type = dow === 0 || dow === 6 ? 'weekend' : 'weekday';
  const model = modelForDate(models, 'weekday', dow, type) ?? modelForDate(models, 'day_type', dow, type);
  if (!model) return null;
  const today = localDate(now);
  const observedDays = new Set(model.occurrences.map((item) => localDate(item.estimatedAt)).filter((day) => day !== today)).size;
  let possibleDays = 0;
  for (let offset = 1; offset <= WINDOW_DAYS; offset += 1) {
    const historical = new Date(now);
    historical.setHours(0, 0, 0, 0);
    historical.setDate(historical.getDate() - offset);
    const historicalDow = historical.getDay();
    const matches = model.basis === 'weekday'
      ? historicalDow === dow
      : (historicalDow === 0 || historicalDow === 6 ? 'weekend' : 'weekday') === type;
    if (matches) possibleDays += 1;
  }
  const raw = probabilityFromRate(possibleDays > 0 ? observedDays / possibleDays : 0);
  const bucket = calibration?.[raw];
  // Require several settled forecasts and use a small prior so a short streak
  // cannot make the visible level jump abruptly.
  if (!bucket || bucket.total < 5) return raw;
  return probabilityFromRate((bucket.hits + 1) / (bucket.total + 2));
}

function probabilityFromRate(rate: number): PredictionConfidence {
  if (rate >= 0.5) return 'high';
  if (rate >= 0.25) return 'medium';
  return 'low';
}

/** Split detector times into concentrated windows; a large gap means a separate opening. */
function clusterSlots(values: Array<{ value: number; weight: number; platformTimed?: boolean }>): TimeSlot[] {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return [];
  const groups: Array<Array<{ value: number; weight: number; platformTimed?: boolean }>> = [[sorted[0]!]];
  for (const value of sorted.slice(1)) {
    const current = groups[groups.length - 1]!;
    if (value.value - current[current.length - 1]!.value > 180) groups.push([value]);
    else current.push(value);
  }
  if (groups.length > 1 && sorted[0]!.value + 1440 - sorted[sorted.length - 1]!.value <= 180) {
    const first = groups.shift()!;
    groups[groups.length - 1]!.push(...first.map((item) => ({ ...item, value: item.value + 1440 })));
  }
  return groups.map((group) => ({
    start: weightedQuantile(group, 0.25),
    end: weightedQuantile(group, 0.75),
    representative: weightedQuantile(group, 0.5),
    wrapsMidnight: group.some((item) => item.value >= 1440),
    weight: group.reduce((sum, item) => sum + item.weight, 0),
    platformWeight: group.filter((item) => item.platformTimed).reduce((sum, item) => sum + item.weight, 0),
    count: group.length,
  }));
}

function confidenceFor(basis: PredictionBasis, samples: number, windowWidth: number, quality: number): PredictionConfidence {
  if (basis !== 'all' && samples >= 6 && windowWidth <= 60 && quality >= 0.7) return 'high';
  if (samples >= 4 && windowWidth <= 120 && quality >= 0.45) return 'medium';
  return 'low';
}

function weightedQuantile(values: Array<{ value: number; weight: number }>, q: number): number {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return sorted[Math.floor((sorted.length - 1) * q)]!.value;
  const threshold = total * q;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) return item.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toOccurrence(event: DetectedLiveEvent): LiveOccurrence | null {
  const detectedAt = Date.parse(event.detectedAt);
  if (!Number.isFinite(detectedAt)) return null;
  const platformStartedAt = event.platformStartedAt ? Date.parse(event.platformStartedAt) : Number.NaN;
  if (event.source === 'platform' && Number.isFinite(platformStartedAt) && platformStartedAt <= detectedAt + 5 * 60 * 1_000) {
    return { estimatedAt: platformStartedAt, recordedAt: platformStartedAt, weight: 1, platformTimed: true, quality: 'platform' };
  }
  const lowerBoundAt = event.lowerBoundAt ? Date.parse(event.lowerBoundAt) : Number.NaN;
  const hasUsableLowerBound = Number.isFinite(lowerBoundAt) && lowerBoundAt <= detectedAt;
  const intervalMs = hasUsableLowerBound ? detectedAt - lowerBoundAt : Number.POSITIVE_INFINITY;
  const source = event.source ?? 'legacy';
  // A very old lower bound (for example after a long shutdown) says little about
  // the start time. Keep the observation, but do not invent a midpoint days ago.
  const estimatedAt = hasUsableLowerBound && intervalMs <= 6 * 60 * 60 * 1000
    ? lowerBoundAt + intervalMs / 2
    : detectedAt;
  const baseWeight = source === 'transition' ? 1 : source === 'initial_live' ? 0.4 : source === 'recording' ? 0.3 : 0.8;
  const intervalWeight = source === 'legacy' || (source === 'transition' && !hasUsableLowerBound) || intervalMs <= 2 * 60 * 60 * 1000
    ? 1
    : intervalMs <= 6 * 60 * 60 * 1000 ? 0.7 : 0.45;
  const quality: PredictionObservationQuality = source === 'transition'
    ? 'transition'
    : source === 'initial_live'
      ? 'initial_live'
      : 'legacy';
  return { estimatedAt, recordedAt: detectedAt, weight: baseWeight * intervalWeight, platformTimed: false, quality };
}

/**
 * Makes a conservative bridge for installations that have recordings from before
 * live-event tracking existed. One start per stream session (or local day when
 * no session id is available) avoids reconnect segments becoming extra samples.
 */
export function recordingFallbackEvents(recordings: Array<{ startedAt: string; streamSessionId?: string | null }>): DetectedLiveEvent[] {
  const seen = new Set<string>();
  return [...recordings]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .flatMap((recording) => {
      const startedAt = Date.parse(recording.startedAt);
      if (!Number.isFinite(startedAt)) return [];
      const key = recording.streamSessionId?.trim() || `day:${localDate(startedAt)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ detectedAt: recording.startedAt, source: 'recording' as const }];
    });
}

function minuteOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

function hhmmFromMinutes(minutes: number): string {
  const normal = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normal / 60)).padStart(2, '0')}:${String(normal % 60).padStart(2, '0')}`;
}

function hhmmWithNextDay(minutes: number): string {
  return `${minutes >= 1440 ? '次日 ' : ''}${hhmmFromMinutes(minutes)}`;
}

function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
