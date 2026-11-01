// 读写小红书主播与直播间的对应关系，切换场次时保留原房间及其历史记录。
import type { DB } from '../connection.js';

export class XiaohongshuSourceRepository {
  constructor(private db: DB) {}

  load(profile: string): string | undefined {
    return (this.db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url=?')
      .get(profile) as { room_url: string } | undefined)?.room_url;
  }

  profileForRoom(url: string): string | undefined {
    return (this.db.prepare('SELECT profile_url FROM xiaohongshu_sources WHERE room_url=?')
      .get(url) as { profile_url: string } | undefined)?.profile_url;
  }

  loadProfile(profile: string): string | undefined {
    return (this.db.prepare('SELECT profile_request_url FROM xiaohongshu_sources WHERE profile_url=?')
      .get(profile) as { profile_request_url?: string } | undefined)?.profile_request_url;
  }

  saveProfile(profile: string, url: string): void {
    this.db.prepare(`INSERT INTO xiaohongshu_sources (profile_url, room_url, profile_request_url) VALUES (?, ?, ?)
      ON CONFLICT(profile_url) DO UPDATE SET profile_request_url=excluded.profile_request_url`).run(profile, '', url);
  }

  /** 参数由平台层校验、规范化；房间地址与映射在同一事务中更新。 */
  save(profile: string, url: string): void {
    this.db.transaction(() => {
      const previous = this.load(profile);
      const tracked = this.db.prepare("SELECT id FROM rooms WHERE platform='xiaohongshu' AND (url=? OR url=?) LIMIT 1")
        .get(previous ?? profile, profile) as { id: string } | undefined;
      // 已有的另一条房间记录不能被覆盖，也不能丢失其历史。
      const collision = this.db.prepare("SELECT id FROM rooms WHERE platform='xiaohongshu' AND url=?")
        .get(url) as { id: string } | undefined;
      if (tracked && (!collision || collision.id === tracked.id)) {
        this.db.prepare('UPDATE rooms SET url=? WHERE id=? AND url<>?').run(url, tracked.id, url);
      }
      this.db.prepare(`INSERT INTO xiaohongshu_sources(profile_url,room_url) VALUES (?,?)
        ON CONFLICT(profile_url) DO UPDATE SET room_url=excluded.room_url`).run(profile, url);
    })();
  }
}
