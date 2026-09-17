import type { DB } from '../connection.js';
import type { PredictionConfidence, PredictionCoverageInterval } from '../../core/live-prediction.js';

export type PredictionOutcome = 'hit' | 'miss' | 'unknown';

export interface PredictionForecast {
  id: number;
  roomId: string;
  targetDate: string;
  probability: PredictionConfidence;
  generatedAt: string;
  outcome: PredictionOutcome | null;
  rawProbability: PredictionConfidence | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
}

export interface PredictionCoverage {
  checks: number;
  firstCheckedAt: string;
  lastCheckedAt: string;
}

/** 录制起点：预测把它当成弱开播证据（source: 'recording'）。 */
export interface PredictionRecordingSession {
  startedAt: string;
  streamSessionId: string | null;
}
export type CalibrationProfile = Partial<Record<PredictionConfidence, { hits: number; total: number }>>;

/** Local-only forecast bookkeeping. It never participates in recording or platform polling. */
export class PredictionCalibrationRepository {
  constructor(private db: DB) {}

  recordForecast(input: {
    roomId: string;
    targetDate: string;
    probability: PredictionConfidence;
    generatedAt: string;
    rawProbability?: PredictionConfidence;
    windowStartAt?: string;
    windowEndAt?: string;
  }): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO prediction_forecasts (room_id, target_date, probability, generated_at, raw_probability, window_start_at, window_end_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.roomId,
          input.targetDate,
          input.probability,
          input.generatedAt,
          input.rawProbability ?? null,
          input.windowStartAt ?? null,
          input.windowEndAt ?? null,
        ).changes > 0
    );
  }

  recordCoverage(roomId: string, targetDate: string, checkedAt: string, maxGapMs = 180_000): void {
    this.db
      .prepare(
        `INSERT INTO prediction_coverage (room_id, target_date, first_checked_at, last_checked_at, checks) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(room_id, target_date) DO UPDATE SET last_checked_at = excluded.last_checked_at, checks = prediction_coverage.checks + 1`,
      )
      .run(roomId, targetDate, checkedAt, checkedAt);
    const last = this.db
      .prepare(
        `SELECT start_at AS startAt, end_at AS endAt FROM prediction_coverage_intervals WHERE room_id = ? ORDER BY start_at DESC LIMIT 1`,
      )
      .get(roomId) as PredictionCoverageInterval | undefined;
    const gap = last ? Date.parse(checkedAt) - Date.parse(last.endAt) : Infinity;
    if (last && gap >= 0 && gap <= maxGapMs) {
      this.db
        .prepare(`UPDATE prediction_coverage_intervals SET end_at = ? WHERE room_id = ? AND start_at = ?`)
        .run(checkedAt, roomId, last.startAt);
    } else if (gap >= 0) {
      this.db
        .prepare(`INSERT OR IGNORE INTO prediction_coverage_intervals (room_id, start_at, end_at) VALUES (?, ?, ?)`)
        .run(roomId, checkedAt, checkedAt);
    }
  }

  intervals(roomIds: string[], from: string): Map<string, PredictionCoverageInterval[]> {
    const result = new Map<string, PredictionCoverageInterval[]>();
    if (!roomIds.length) return result;
    const rows = this.db
      .prepare(
        `SELECT room_id AS roomId, start_at AS startAt, end_at AS endAt FROM prediction_coverage_intervals WHERE room_id IN (${roomIds.map(() => '?').join(',')}) AND end_at >= ? ORDER BY start_at`,
      )
      .all(...roomIds, from) as Array<PredictionCoverageInterval & { roomId: string }>;
    for (const row of rows) {
      const items = result.get(row.roomId) ?? [];
      items.push({ startAt: row.startAt, endAt: row.endAt });
      result.set(row.roomId, items);
    }
    return result;
  }

  /** 录制起点证据（按房间分组，供预测与导出使用）。 */
  recordingSessions(roomIds: string[], from: string): Map<string, PredictionRecordingSession[]> {
    const result = new Map<string, PredictionRecordingSession[]>();
    if (roomIds.length === 0) return result;
    const placeholders = roomIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT room_id AS roomId, started_at AS startedAt, stream_session_id AS streamSessionId FROM prediction_recording_sessions WHERE room_id IN (${placeholders}) AND started_at >= ? ORDER BY started_at`,
      )
      .all(...roomIds, from) as Array<PredictionRecordingSession & { roomId: string }>;
    for (const row of rows) {
      const items = result.get(row.roomId) ?? [];
      items.push({ startedAt: row.startedAt, streamSessionId: row.streamSessionId });
      result.set(row.roomId, items);
    }
    return result;
  }

  /** 记录一条录制起点证据；已存在同一时刻则忽略（导入幂等的关键）。 */
  recordRecordingSession(roomId: string, startedAt: string, streamSessionId: string | null): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO prediction_recording_sessions (room_id, started_at, stream_session_id) VALUES (?, ?, ?)')
        .run(roomId, startedAt, streamSessionId).changes > 0
    );
  }

  allRecordingSessions(): Array<PredictionRecordingSession & { roomId: string }> {
    return this.db
      .prepare('SELECT room_id AS roomId, started_at AS startedAt, stream_session_id AS streamSessionId FROM prediction_recording_sessions ORDER BY started_at')
      .all() as Array<PredictionRecordingSession & { roomId: string }>;
  }

  pendingBefore(targetDate: string): PredictionForecast[] {
    return this.db
      .prepare(
        `SELECT id, room_id AS roomId, target_date AS targetDate, probability, generated_at AS generatedAt, outcome, raw_probability AS rawProbability, window_start_at AS windowStartAt, window_end_at AS windowEndAt FROM prediction_forecasts WHERE outcome IS NULL AND target_date <= ?`,
      )
      .all(targetDate) as PredictionForecast[];
  }

  coverage(roomId: string, targetDate: string): PredictionCoverage | null {
    const row = this.db
      .prepare(
        `SELECT checks, first_checked_at AS firstCheckedAt, last_checked_at AS lastCheckedAt FROM prediction_coverage WHERE room_id = ? AND target_date = ?`,
      )
      .get(roomId, targetDate) as PredictionCoverage | undefined;
    return row ?? null;
  }

  resolve(id: number, outcome: PredictionOutcome, resolvedAt: string): void {
    this.db
      .prepare(`UPDATE prediction_forecasts SET outcome = ?, resolved_at = ? WHERE id = ? AND outcome IS NULL`)
      .run(outcome, resolvedAt, id);
  }

  profiles(roomIds: string[], fromDate: string): Map<string, CalibrationProfile> {
    const result = new Map<string, CalibrationProfile>();
    if (roomIds.length === 0) return result;
    const placeholders = roomIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT room_id AS roomId, raw_probability AS probability, outcome FROM prediction_forecasts WHERE room_id IN (${placeholders}) AND target_date >= ? AND raw_probability IS NOT NULL AND outcome IN ('hit', 'miss')`,
      )
      .all(...roomIds, fromDate) as Array<{ roomId: string; probability: PredictionConfidence; outcome: PredictionOutcome }>;
    for (const row of rows) {
      const profile = result.get(row.roomId) ?? {};
      const bucket = profile[row.probability] ?? { hits: 0, total: 0 };
      bucket.total += 1;
      if (row.outcome === 'hit') bucket.hits += 1;
      profile[row.probability] = bucket;
      result.set(row.roomId, profile);
    }
    return result;
  }
}
