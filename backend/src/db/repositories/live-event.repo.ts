import type { DB } from '../connection.js';
import { newId } from '../../utils/id.js';

export interface LiveEvent {
  id: string;
  roomId: string;
  detectedAt: string;
}

/** Persisted offline-to-live observations. These are intentionally independent from recording sessions. */
export class LiveEventRepository {
  constructor(private db: DB) {}

  record(roomId: string, detectedAt: string): LiveEvent {
    const event: LiveEvent = { id: newId('lev'), roomId, detectedAt };
    this.db.prepare(`INSERT INTO live_events (id, room_id, detected_at) VALUES (?, ?, ?)`).run(event.id, event.roomId, event.detectedAt);
    return event;
  }

  list(roomId: string, from: string): LiveEvent[] {
    return this.db.prepare(
      `SELECT id, room_id AS roomId, detected_at AS detectedAt FROM live_events WHERE room_id = ? AND detected_at >= ? ORDER BY detected_at ASC`,
    ).all(roomId, from) as LiveEvent[];
  }

  listForRooms(roomIds: string[], from: string): LiveEvent[] {
    if (roomIds.length === 0) return [];
    const placeholders = roomIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT id, room_id AS roomId, detected_at AS detectedAt FROM live_events WHERE room_id IN (${placeholders}) AND detected_at >= ? ORDER BY detected_at ASC`,
    ).all(...roomIds, from) as LiveEvent[];
  }
}
