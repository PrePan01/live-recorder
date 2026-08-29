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
  startAt: string | null;
  endAt: string | null;
  confidence: LivePredictionConfidence | null;
  basedOnDays: number | null;
  notice: string | null;
  generatedAt: string;
}