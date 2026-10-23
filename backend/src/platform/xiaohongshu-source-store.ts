import type { DB } from '../db/connection.js';
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from './xiaohongshu-url.js';

/** Move the tracked broadcast while retaining its local room ID and all history. */
export function saveXiaohongshuSource(db: DB, profile: string, raw: string): void {
  if (parseXiaohongshuUrl(profile)?.kind !== 'profile' || parseXiaohongshuUrl(raw)?.kind !== 'room') return;
  const url = normalizeXiaohongshuUrl(raw);
  db.transaction(() => {
    const previous = db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url=?').get(profile) as { room_url: string } | undefined;
    const tracked = db.prepare("SELECT id FROM rooms WHERE platform='xiaohongshu' AND (url=? OR url=?) LIMIT 1").get(previous?.room_url ?? profile, profile) as { id: string } | undefined;
    // A separate existing record must never be overwritten or lose its history.
    const collision = db.prepare("SELECT id FROM rooms WHERE platform='xiaohongshu' AND url=?").get(url) as { id: string } | undefined;
    if (tracked && (!collision || collision.id === tracked.id)) {
      db.prepare('UPDATE rooms SET url=? WHERE id=? AND url<>?').run(url, tracked.id, url);
    }
    db.prepare('INSERT INTO xiaohongshu_sources(profile_url,room_url) VALUES (?,?) ON CONFLICT(profile_url) DO UPDATE SET room_url=excluded.room_url').run(profile, url);
  })();
}
