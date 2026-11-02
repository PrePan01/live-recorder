import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { RoomRepository } from '../../src/db/repositories/room.repo.js';
import { RecordingRepository } from '../../src/db/repositories/recording.repo.js';
import { XiaohongshuSourceRepository } from '../../src/db/repositories/xiaohongshu-source.repo.js';
import { saveXiaohongshuSource } from '../../src/platform/xiaohongshu/source-store.js';

const profile = 'https://www.xiaohongshu.com/user/profile/abcdef';
const previous = 'https://www.xiaohongshu.com/livestream/123?xsec_token=old';
const current = 'https://www.xiaohongshu.com/livestream/456?xsec_token=new';
let db: DB;
let sources: XiaohongshuSourceRepository;
let rooms: RoomRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  sources = new XiaohongshuSourceRepository(db);
  rooms = new RoomRepository(db);
});
afterEach(() => db.close());

describe('Xiaohongshu source persistence', () => {
  it.each([profile, previous])('retains the local room and recording history when advancing from %s', initial => {
    const room = rooms.create({ platform: 'xiaohongshu', url: initial, displayName: '主播', enabled: false });
    const recordings = new RecordingRepository(db);
    const recording = recordings.create({ roomId: room.id, roomName: '主播', platform: 'xiaohongshu', streamSessionId: '123', streamTitle: '上一场直播' });
    sources.saveProfile(profile, profile + '?xsec_token=profile');
    saveXiaohongshuSource(db, profile, previous);
    saveXiaohongshuSource(db, profile, current);
    expect(rooms.list()).toHaveLength(1);
    expect(rooms.get(room.id)).toMatchObject({ ...room, url: current });
    expect(recordings.get(recording.id)).toMatchObject({ roomId: room.id, streamSessionId: '123', streamTitle: '上一场直播' });
    expect(sources.load(profile)).toBe(current);
    expect(sources.profileForRoom(current)).toBe(profile);
    expect(sources.loadProfile(profile)).toBe(profile + '?xsec_token=profile');
  });

  it('preserves both rooms on a URL collision while updating the host mapping', () => {
    rooms.create({ platform: 'xiaohongshu', url: previous, displayName: '旧场次' });
    rooms.create({ platform: 'xiaohongshu', url: current, displayName: '另一个已有房间' });
    const before = rooms.list();
    saveXiaohongshuSource(db, profile, previous);
    saveXiaohongshuSource(db, profile, current);
    expect(rooms.list()).toEqual(before);
    expect(sources.load(profile)).toBe(current);
  });

  it('rolls back the room URL if saving the mapping fails, including inside an outer transaction', () => {
    const room = rooms.create({ platform: 'xiaohongshu', url: previous, displayName: '主播' });
    const before = rooms.get(room.id);
    saveXiaohongshuSource(db, profile, previous);
    db.exec("CREATE TRIGGER reject_source_update BEFORE UPDATE ON xiaohongshu_sources BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    db.transaction(() => {
      expect(() => saveXiaohongshuSource(db, profile, current)).toThrow('test write failure');
      expect(rooms.get(room.id)).toEqual(before);
      expect(sources.load(profile)).toBe(previous);
    })();
  });

  it('keeps link validation and normalization at the platform entry point', () => {
    saveXiaohongshuSource(db, previous, current);
    saveXiaohongshuSource(db, profile, 'https://example.com/livestream/456');
    expect(sources.load(profile)).toBeUndefined();
    saveXiaohongshuSource(db, profile, current + '&track_id=unused');
    expect(sources.load(profile)).toBe(current);
    expect(rooms.list()).toEqual([]);
    sources.saveProfile(profile, profile + '?xsec_token=profile');
    expect(sources.load(profile)).toBe(current);
    expect(sources.loadProfile(profile)).toBe(profile + '?xsec_token=profile');
  });
});
