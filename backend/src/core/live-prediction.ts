export type PredictionConfidence = 'high' | 'medium' | 'low';
export type PredictionKind = 'unavailable' | 'observation' | 'typical' | 'next';
export type PredictionBasis = 'weekday' | 'day_type' | 'all';
export type PredictionTimeGranularity = 'exact' | 'approximate' | 'period';

export interface DetectedLiveEvent {
  detectedAt: string;
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
  slots: Array<{ startAt: string; endAt: string }>;
}

interface LiveOccurrence {
  detectedAt: number;
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
}

const WINDOW_DAYS = 60;
const MIN_MODEL_SAMPLES = 3;

/**
 * Calculates a display-oriented prediction from offline-to-live detector observations only.
 * Recording start/stop times never participate in this calculation.
 */
export function calculateLivePrediction(input: {
  roomId: string;
  events: DetectedLiveEvent[];
  now: number;
  generatedAt: string;
}): LivePrediction {
  const cutoff = input.now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const occurrences = input.events
    .map((event) => Date.parse(event.detectedAt))
    .filter((detectedAt) => Number.isFinite(detectedAt) && detectedAt >= cutoff)
    .map((detectedAt) => ({ detectedAt }))
    .sort((a, b) => a.detectedAt - b.detectedAt);
  const basedOnDays = new Set(occurrences.map((occurrence) => localDate(occurrence.detectedAt))).size;
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
    ...overrides,
  });

  if (occurrences.length === 0) return base({ notice: '检测到更多开播后显示预测' });
  if (occurrences.length < MIN_MODEL_SAMPLES) {
    const starts = occurrences.map((occurrence) => minuteOfDay(occurrence.detectedAt));
    return base({
      kind: 'observation',
      startAt: hhmmFromMinutes(Math.round(median(starts))),
      sampleCount: occurrences.length,
      notice: occurrences.length === 1 ? '基于最近一次开播检测' : `基于本机近 ${occurrences.length} 次开播检测`,
    });
  }

  const models = modelCandidates(occurrences);
  const selected = selectUpcomingModel(models, input.now);
  if (selected) return predictionForModel(base, selected.model, selected.date, selected.slot);
  return predictionForModel(base, { basis: 'all', occurrences }, null);
}

function modelCandidates(occurrences: LiveOccurrence[]): Model[] {
  const weekday = new Map<number, LiveOccurrence[]>();
  const dayType = new Map<'weekday' | 'weekend', LiveOccurrence[]>();
  for (const occurrence of occurrences) {
    const date = new Date(occurrence.detectedAt);
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
      const model = models.find((item) => item.basis === basis && (basis === 'weekday'
        ? new Date(item.occurrences[0]!.detectedAt).getDay() === dow
        : (new Date(item.occurrences[0]!.detectedAt).getDay() === 0 || new Date(item.occurrences[0]!.detectedAt).getDay() === 6 ? 'weekend' : 'weekday') === type));
      if (!model) continue;
      const slots = clusterSlots(model.occurrences.map((occurrence) => minuteOfDay(occurrence.detectedAt)));
      const nowMinutes = offset === 0 ? minuteOfDay(now) : -1;
      const slot = slots.find((candidate) => offset > 0 || candidate.end >= nowMinutes);
      if (slot) return { model, date, slot };
    }
  }
  return null;
}

function predictionForModel(base: (overrides: Partial<LivePrediction>) => LivePrediction, model: Model, nextDate: Date | null, selectedSlot?: TimeSlot): LivePrediction {
  const starts = model.occurrences.map((occurrence) => minuteOfDay(occurrence.detectedAt));
  const slots = clusterSlots(starts);
  const slot = selectedSlot ?? slots[0]!;
  const representativeStart = Math.round(slot.representative);
  const windowWidth = slot.end - slot.start;
  const confidence = confidenceFor(model.basis, model.occurrences.length, windowWidth);
  const granularity: PredictionTimeGranularity = confidence === 'high' ? 'exact' : confidence === 'medium' ? 'approximate' : 'period';
  const windowStart = Math.round(slot.start);
  const windowEnd = Math.max(Math.round(slot.end), windowStart + 20);
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
    slots: slots.map((item) => ({ startAt: hhmmWithNextDay(item.start), endAt: hhmmWithNextDay(Math.max(item.end, item.start + 20)) })),
  });
}

/** Split detector times into concentrated windows; a large gap means a separate opening. */
function clusterSlots(values: number[]): TimeSlot[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const groups: number[][] = [[sorted[0]!]];
  for (const value of sorted.slice(1)) {
    const current = groups[groups.length - 1]!;
    if (value - current[current.length - 1]! > 180) groups.push([value]);
    else current.push(value);
  }
  if (groups.length > 1 && sorted[0]! + 1440 - sorted[sorted.length - 1]! <= 180) {
    const first = groups.shift()!;
    groups[groups.length - 1]!.push(...first.map((value) => value + 1440));
  }
  return groups.map((group) => ({
    start: quantile(group, 0.25),
    end: quantile(group, 0.75),
    representative: median(group),
    wrapsMidnight: group.some((value) => value >= 1440),
  }));
}

function confidenceFor(basis: PredictionBasis, samples: number, windowWidth: number): PredictionConfidence {
  if (basis !== 'all' && samples >= 6 && windowWidth <= 60) return 'high';
  if (samples >= 4 && windowWidth <= 120) return 'medium';
  return 'low';
}

function median(values: number[]): number { return quantile(values, 0.5); }

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
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
