import type { DB } from '../connection.js';
import type { PredictionConfidence } from '../../core/live-prediction.js';

export type PredictionOutcome = 'hit' | 'miss' | 'unknown';

export interface PredictionForecast {
  id: number;
  roomId: string;
  targetDate: string;
  probability: PredictionConfidence;
  generatedAt: string;
  outcome: PredictionOutcome | null;
}

export interface PredictionCoverage { checks: number; firstCheckedAt: string; lastCheckedAt: string; }
export type CalibrationProfile = Partial<Record<PredictionConfidence, { hits: number; total: number }>>;

/** Local-only forecast bookkeeping. It never participates in recording or platform polling. */
export class PredictionCalibrationRepository {
  constructor(private db: DB) {}

  recordForecast(input: { roomId: string; targetDate: string; probability: PredictionConfidence; generatedAt: string }): void {
    this.db.prepare(`INSERT OR IGNORE INTO prediction_forecasts (room_id, target_date, probability, generated_at) VALUES (?, ?, ?, ?)`).run(input.roomId, input.targetDate, input.probability, input.generatedAt);
  }

  recordCoverage(roomId: string, targetDate: string, checkedAt: string): void {
    this.db.prepare(`INSERT INTO prediction_coverage (room_id, target_date, first_checked_at, last_checked_at, checks) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(room_id, target_date) DO UPDATE SET last_checked_at = excluded.last_checked_at, checks = prediction_coverage.checks + 1`).run(roomId, targetDate, checkedAt, checkedAt);
  }

  pendingBefore(targetDate: string): PredictionForecast[] {
    return this.db.prepare(`SELECT id, room_id AS roomId, target_date AS targetDate, probability, generated_at AS generatedAt, outcome FROM prediction_forecasts WHERE outcome IS NULL AND target_date < ?`).all(targetDate) as PredictionForecast[];
  }

  coverage(roomId: string, targetDate: string): PredictionCoverage | null {
    const row = this.db.prepare(`SELECT checks, first_checked_at AS firstCheckedAt, last_checked_at AS lastCheckedAt FROM prediction_coverage WHERE room_id = ? AND target_date = ?`).get(roomId, targetDate) as PredictionCoverage | undefined;
    return row ?? null;
  }

  resolve(id: number, outcome: PredictionOutcome, resolvedAt: string): void {
    this.db.prepare(`UPDATE prediction_forecasts SET outcome = ?, resolved_at = ? WHERE id = ? AND outcome IS NULL`).run(outcome, resolvedAt, id);
  }

  profiles(roomIds: string[], fromDate: string): Map<string, CalibrationProfile> {
    const result = new Map<string, CalibrationProfile>();
    if (roomIds.length === 0) return result;
    const placeholders = roomIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT room_id AS roomId, probability, outcome FROM prediction_forecasts WHERE room_id IN (${placeholders}) AND target_date >= ? AND outcome IN ('hit', 'miss')`).all(...roomIds, fromDate) as Array<{ roomId: string; probability: PredictionConfidence; outcome: PredictionOutcome }>;
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
