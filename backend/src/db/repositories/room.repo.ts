import type { DB } from '../connection.js';
import { AppError, type ErrorObject, type LiveStatus, type MonitorState, type Platform, type Room, type TitleSource, type Tag } from '../../types/index.js';
import { newId, nowIso } from '../../utils/id.js';
import type { TagRepository } from './tag.repo.js';

interface RoomRow {
  id: string;
  platform: string;
  url: string;
  display_name: string;
  enabled: number;
  favorited: number;
  auto_record: number | null;
  last_live_status: string | null;
  upload_enabled: number | null;
  title_source: string | null;
  title_updated_at: string | null;
  title_fallback_used: number;
  monitor_state: string;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parseError(raw: string | null): ErrorObject | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ErrorObject;
  } catch {
    return null;
  }
}

export function rowToRoom(row: RoomRow, tags: Tag[] = []): Room {
  return {
    id: row.id,
    platform: row.platform as Platform,
    url: row.url,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    favorited: row.favorited === 1,
    autoRecord: row.auto_record === null ? null : row.auto_record === 1,
    lastLiveStatus: (row.last_live_status as LiveStatus) ?? null,
    uploadEnabled: row.upload_enabled === null ? null : row.upload_enabled === 1,
    titleSource: (row.title_source as TitleSource) ?? null,
    titleUpdatedAt: row.title_updated_at,
    titleFallbackUsed: row.title_fallback_used === 1,
    monitorState: row.monitor_state as MonitorState,
    lastCheckedAt: row.last_checked_at,
    lastError: parseError(row.last_error),
    activeRecording: null,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewRoomInput {
  platform: Platform;
  url: string;
  displayName: string;
  enabled?: boolean;
}

export class RoomRepository {
  constructor(private db: DB, private tags: TagRepository | null = null) {}

  private enrich(row: RoomRow): Room {
    const tagRepo = this.tags;
    const tags = tagRepo ? tagRepo.tagsForRoom(row.id) : [];
    return rowToRoom(row, tags);
  }

  list(): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all() as RoomRow[];
    return rows.map((r) => this.enrich(r));
  }

  get(id: string): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row ? this.enrich(row) : null;
  }

  listEnabled(): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms WHERE enabled = 1 ORDER BY created_at ASC').all() as RoomRow[];
    return rows.map((r) => this.enrich(r));
  }

  create(input: NewRoomInput): Room {
    const now = nowIso();
    const room: Room = {
      id: newId('room'),
      platform: input.platform,
      url: input.url,
      displayName: input.displayName,
      enabled: input.enabled ?? true,
      favorited: false,
      autoRecord: null,
      lastLiveStatus: null,
      uploadEnabled: null,
      titleSource: null,
      titleUpdatedAt: null,
      titleFallbackUsed: false,
      monitorState: input.enabled === false ? 'disabled' : 'idle',
      lastCheckedAt: null,
      lastError: null,
      activeRecording: null,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO rooms (id, platform, url, display_name, enabled, favorited, auto_record, last_live_status, upload_enabled, title_source, title_updated_at, title_fallback_used, monitor_state, last_checked_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?)`,
        )
        .run(room.id, room.platform, room.url, room.displayName, room.enabled ? 1 : 0, room.favorited ? 1 : 0, room.monitorState, now, now);
    } catch (err) {
      if (isUniqueConflict(err)) {
        throw new AppError('ROOM_LINK_DUPLICATE', '该直播间已存在', { roomId: this.findIdByPlatformUrl(room.platform, room.url) });
      }
      throw err;
    }
    return room;
  }

  private findIdByPlatformUrl(platform: Platform, url: string): string | null {
    const row = this.db.prepare('SELECT id FROM rooms WHERE platform = ? AND url = ?').get(platform, url) as { id: string } | undefined;
    return row?.id ?? null;
  }

  update(id: string, patch: Partial<Pick<Room, 'url' | 'displayName' | 'enabled' | 'favorited' | 'autoRecord' | 'uploadEnabled' | 'titleSource' | 'titleUpdatedAt' | 'titleFallbackUsed'>>): Room {
    const existing = this.get(id);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    const next: Room = { ...existing, ...patch, updatedAt: nowIso() };
    if (patch.enabled !== undefined) {
      next.monitorState = !patch.enabled ? 'disabled' : existing.monitorState === 'disabled' ? 'idle' : existing.monitorState;
    }
    try {
      this.db
        .prepare(
          `UPDATE rooms SET url = ?, display_name = ?, enabled = ?, favorited = ?, auto_record = ?, upload_enabled = ?, title_source = ?, title_updated_at = ?, title_fallback_used = ?, monitor_state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.url,
          next.displayName,
          next.enabled ? 1 : 0,
          next.favorited ? 1 : 0,
          next.autoRecord === null ? null : next.autoRecord ? 1 : 0,
          next.uploadEnabled === null ? null : next.uploadEnabled ? 1 : 0,
          next.titleSource ?? null,
          next.titleUpdatedAt ?? null,
          next.titleFallbackUsed ? 1 : 0,
          next.monitorState,
          next.updatedAt,
          id,
        );
    } catch (err) {
      if (isUniqueConflict(err)) {
        throw new AppError('ROOM_LINK_DUPLICATE', '该直播间已存在', { roomId: id });
      }
      throw err;
    }
    return this.get(id)!;
  }

  setFavorite(id: string, favorited: boolean): Room {
    const existing = this.get(id);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    return this.update(id, { favorited });
  }

  setState(id: string, state: MonitorState, opts: { lastCheckedAt?: string; lastError?: ErrorObject | null } = {}): void {
    this.db
      .prepare(
        `UPDATE rooms SET monitor_state = ?, last_checked_at = COALESCE(?, last_checked_at), last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(state, opts.lastCheckedAt ?? null, opts.lastError ? JSON.stringify(opts.lastError) : null, nowIso(), id);
  }

  /** 写入最近一次检测的直播状态（#78）。 */
  setLiveStatus(id: string, status: LiveStatus): void {
    this.db
      .prepare(`UPDATE rooms SET last_live_status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
  }

  /** 写入房间标题识别元数据（V5 #91：识别来源/时间/回退标记）。 */
  setTitleInfo(id: string, info: { titleSource: TitleSource; titleFallbackUsed: boolean }): void {
    this.db
      .prepare(`UPDATE rooms SET title_source = ?, title_updated_at = ?, title_fallback_used = ?, updated_at = ? WHERE id = ?`)
      .run(info.titleSource, nowIso(), info.titleFallbackUsed ? 1 : 0, nowIso(), id);
  }

  remove(id: string): void {
    // #92：仅移除监控配置，不再级联删除该房间的录制历史（迁移 v8 已去掉外键）。
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }
}

export function isUniqueConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    String((err as { message?: string }).message ?? '').includes('UNIQUE constraint failed: rooms.platform, rooms.url');
}
