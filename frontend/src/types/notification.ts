export interface NotificationEventPreference {
  liveStarted: boolean;
  recordingStarted: boolean;
  recordingEnded: boolean;
  recordingFailed: boolean;
  diskSpaceLow: boolean;
  uploadFailed: boolean;
}

export interface NotificationPreference {
  desktop: NotificationEventPreference;
  email: NotificationEventPreference;
  dedupeWindowMinutes: number;
}

export interface NotificationPreferenceInput {
  desktop?: Partial<NotificationEventPreference>;
  email?: Partial<NotificationEventPreference>;
  dedupeWindowMinutes?: number;
}

export type LivePredictionConfidence = 'high' | 'medium' | 'low';

export interface LivePrediction {
  roomId: string;
  kind: 'unavailable' | 'observation' | 'typical' | 'next';
  basis: 'daily' | 'weekday' | 'day_type' | 'interval' | 'all' | null;
  intervalDays?: number | null;
  intervalDaysMax?: number | null;
  nextDate: string | null;
  startTimestamp?: string | null;
  windowStartTimestamp?: string | null;
  windowEndTimestamp?: string | null;
  rawLikelihood?: "high" | "medium" | "low" | null;
  probabilityKnown?: boolean;
  accuracy?: 'high' | 'fairly_high' | 'medium' | 'fairly_low' | 'low' | null;
  coverageDays?: number;
  timeSource?: 'platform' | 'detected' | 'recording' | 'mixed' | null;
  sampleCount: number;
  timeGranularity: 'exact' | 'quarter_hour' | 'approximate' | 'period' | null;
  windowStart: string | null;
  windowEnd: string | null;
  slots: Array<{ startAt: string; endAt: string; likelihood: LivePredictionConfidence; probabilityKnown?: boolean }>;
  todayProbability: LivePredictionConfidence | null;
  likelihood: LivePredictionConfidence | null;
  lastRecordedAt: string | null;
    lastRecordedTimestamp?: string | null;
    lastRecordedQuality?: "platform" | "transition" | "initial_live" | "legacy";
    nextDateEnd?: string | null;
    typicalDayType?: string | null;
  recentObservations: Array<{ time: string; quality: "platform" | "transition" | "initial_live" | "legacy" }>;
  startAt: string | null;
  endAt: string | null;
  confidence: LivePredictionConfidence | null;
  basedOnDays: number | null;
  notice: string | null;
  generatedAt: string;
}
