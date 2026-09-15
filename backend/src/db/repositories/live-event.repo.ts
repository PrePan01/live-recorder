import type { DB } from '../connection.js';
import { newId } from '../../utils/id.js';

export interface LiveEvent {
  id: string;
  roomId: string;
  detectedAt: string;
  source: LiveEventSource;
  lowerBoundAt: string | null;
  platformStartedAt: string | null;
}

export type LiveEventSource = 'platform' | 'transition' | 'initial_live' | 'legacy';

/** Persisted live observations. These are intentionally independent from recording sessions. */
export class LiveEventRepository {
  constructor(private db: DB) {}

  record(roomId: string, detectedAt: string, observation: { source?: Exclude<LiveEventSource, 'legacy'>; lowerBoundAt?: string | null; platformStartedAt?: string | null } = {}): LiveEvent {
    const event: LiveEvent = {
      id: newId('lev'), roomId, detectedAt,
      source: observation.source ?? 'transition',
      lowerBoundAt: observation.lowerBoundAt ?? null,
      platformStartedAt: observation.platformStartedAt ?? null,
    };
    this.db.prepare(`INSERT INTO live_events (id, room_id, detected_at, source, lower_bound_at, platform_started_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      event.id, event.roomId, event.detectedAt, event.source, event.lowerBoundAt, event.platformStartedAt,
    );
    return event;
  }

  /** Indexed, constant-size change check for scheduler forecast retries. */
  latestId(roomId: string): string | null {
    const row = this.db.prepare('SELECT id FROM live_events WHERE room_id = ? ORDER BY detected_at DESC LIMIT 1').get(roomId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  list(roomId: string, from: string): LiveEvent[] {
    return this.db.prepare(
      `SELECT id, room_id AS roomId, detected_at AS detectedAt, source, lower_bound_at AS lowerBoundAt, platform_started_at AS platformStartedAt FROM live_events WHERE room_id = ? AND detected_at >= ? ORDER BY detected_at ASC`,
    ).all(roomId, from) as LiveEvent[];
  }

  listBetween(roomId: string, from: string, to: string): LiveEvent[] {
    return this.db.prepare(
      `SELECT id, room_id AS roomId, detected_at AS detectedAt, source, lower_bound_at AS lowerBoundAt, platform_started_at AS platformStartedAt FROM live_events WHERE room_id = ? AND detected_at >= ? AND detected_at < ? ORDER BY detected_at ASC`,
    ).all(roomId, from, to) as LiveEvent[];
  }

  listForRooms(roomIds: string[], from: string): LiveEvent[] {
    if (roomIds.length === 0) return [];
    const placeholders = roomIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT id, room_id AS roomId, detected_at AS detectedAt, source, lower_bound_at AS lowerBoundAt, platform_started_at AS platformStartedAt FROM live_events WHERE room_id IN (${placeholders}) AND detected_at >= ? ORDER BY detected_at ASC`,
    ).all(...roomIds, from) as LiveEvent[];
  }
}
