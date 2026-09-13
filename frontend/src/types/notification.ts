export interface NotificationPreference {
  desktopEnabled: boolean;
  liveStarted: boolean;
  recordingStarted: boolean;
  recordingEnded: boolean;
  recordingFailed: boolean;
  diskSpaceLow: boolean;
  uploadFailed: boolean;
  dedupeWindowMinutes: number;
}

export type LivePredictionConfidence = 'high' | 'medium' | 'low';

export interface LivePrediction {
  roomId: string;
  kind: 'unavailable' | 'observation' | 'typical' | 'next';
  basis: 'weekday' | 'day_type' | 'all' | null;
  nextDate: string | null;
  sampleCount: number;
  timeGranularity: 'exact' | 'approximate' | 'period' | null;
  windowStart: string | null;
  windowEnd: string | null;
  expectedEndAt: string | null;
  slots: Array<{ startAt: string; endAt: string }>;
  startAt: string | null;
  endAt: string | null;
  confidence: LivePredictionConfidence | null;
  basedOnDays: number | null;
  notice: string | null;
  generatedAt: string;
}
