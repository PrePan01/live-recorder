import type { DB } from '../connection.js';
import type { RecordingMarker } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';

type MarkerRow = {
  id: string; recording_id: string; position_seconds: number; text: string;
  created_at: string; updated_at: string;
};

function map(row: MarkerRow): RecordingMarker {
  return {
    id: row.id, recordingId: row.recording_id, positionSeconds: row.position_seconds,
    text: row.text, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class RecordingMarkerRepository {
  constructor(private db: DB) {}

  list(recordingId: string): RecordingMarker[] {
    return (this.db.prepare('SELECT * FROM recording_markers WHERE recording_id = ? ORDER BY position_seconds, created_at').all(recordingId) as MarkerRow[]).map(map);
  }

  create(recordingId: string, positionSeconds: number, text: string): RecordingMarker {
    const now = nowIso();
    const marker: RecordingMarker = { id: newId('mark'), recordingId, positionSeconds, text, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO recording_markers (id, recording_id, position_seconds, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(marker.id, recordingId, positionSeconds, text, now, now);
    return marker;
  }

  update(recordingId: string, id: string, patch: { text?: string; positionSeconds?: number }): RecordingMarker | null {
    const now = nowIso();
    const sets: string[] = []; const values: Array<string | number> = [];
    if (patch.text !== undefined) { sets.push('text = ?'); values.push(patch.text); }
    if (patch.positionSeconds !== undefined) { sets.push('position_seconds = ?'); values.push(patch.positionSeconds); }
    if (sets.length === 0) return null;
    sets.push('updated_at = ?'); values.push(now);
    this.db.prepare(`UPDATE recording_markers SET ${sets.join(', ')} WHERE id = ? AND recording_id = ?`).run(...values, id, recordingId);
    const row = this.db.prepare('SELECT * FROM recording_markers WHERE id = ? AND recording_id = ?').get(id, recordingId) as MarkerRow | undefined;
    return row ? map(row) : null;
  }

  remove(recordingId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM recording_markers WHERE id = ? AND recording_id = ?').run(id, recordingId).changes > 0;
  }

  removeForRecording(recordingId: string): void {
    this.db.prepare('DELETE FROM recording_markers WHERE recording_id = ?').run(recordingId);
  }
}
