import type { DB } from '../connection.js';
import { AppError, type ErrorObject, type LiveStatus, type MonitorState, type Platform, type Quality, type Room, type TitleSource, type Tag } from '../../types/index.js';
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
  live_notification_enabled: number;
  last_live_status: string | null;
  live_started_at: string | null;
  current_stream_title: string | null;
  available_qualities: string | null;
  upload_enabled: number | null;
  title_source: string | null;
  title_updated_at: string | null;
  title_fallback_used: number;
  sort_order: number | null;
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

function parseQualities(raw: string | null): Quality[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((q) => typeof q === 'string') as Quality[]) : [];
  } catch {
    return [];
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
    liveNotificationEnabled: row.live_notification_enabled === 1,
    lastLiveStatus: (row.last_live_status as LiveStatus) ?? null,
    liveStartedAt: row.live_started_at,
    currentStreamTitle: row.current_stream_title,
    availableQualities: parseQualities(row.available_qualities),
    uploadEnabled: row.upload_enabled === null ? null : row.upload_enabled === 1,
    titleSource: (row.title_source as TitleSource) ?? null,
    titleUpdatedAt: row.title_updated_at,
    titleFallbackUsed: row.title_fallback_used === 1,
    sortOrder: row.sort_order ?? 0,
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
  liveNotificationEnabled?: boolean;
}

export class RoomRepository {
  constructor(private db: DB, private tags: TagRepository | null = null) {}

  private enrich(row: RoomRow): Room {
    const tagRepo = this.tags;
    const tags = tagRepo ? tagRepo.tagsForRoom(row.id) : [];
    return rowToRoom(row, tags);
  }

  list(): Room[] {
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY sort_order ASC, created_at DESC, id DESC').all() as RoomRow[];
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
    const first = this.db.prepare('SELECT MIN(sort_order) AS value FROM rooms').get() as { value: number | null };
    const room: Room = {
      id: newId('room'),
      platform: input.platform,
      url: input.url,
      displayName: input.displayName,
      enabled: input.enabled ?? true,
      favorited: false,
      autoRecord: null,
      liveNotificationEnabled: input.liveNotificationEnabled ?? false,
      lastLiveStatus: null,
      liveStartedAt: null,
      currentStreamTitle: null,
      availableQualities: [],
      uploadEnabled: null,
      titleSource: null,
      titleUpdatedAt: null,
      titleFallbackUsed: false,
      sortOrder: (first.value ?? 0) - 1,
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
          `INSERT INTO rooms (id, platform, url, display_name, enabled, favorited, auto_record, live_notification_enabled, last_live_status, upload_enabled, title_source, title_updated_at, title_fallback_used, sort_order, monitor_state, last_checked_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(room.id, room.platform, room.url, room.displayName, room.enabled ? 1 : 0, room.favorited ? 1 : 0, room.liveNotificationEnabled ? 1 : 0, room.sortOrder, room.monitorState, now, now);
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

  update(id: string, patch: Partial<Pick<Room, 'url' | 'displayName' | 'enabled' | 'favorited' | 'autoRecord' | 'liveNotificationEnabled' | 'uploadEnabled' | 'titleSource' | 'titleUpdatedAt' | 'titleFallbackUsed'>>): Room {
    const existing = this.get(id);
    if (!existing) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    const next: Room = { ...existing, ...patch, updatedAt: nowIso() };
    if (patch.enabled !== undefined) {
      next.monitorState = !patch.enabled ? 'disabled' : existing.monitorState === 'disabled' ? 'idle' : existing.monitorState;
    }
    try {
      this.db
        .prepare(
          `UPDATE rooms SET url = ?, display_name = ?, enabled = ?, favorited = ?, auto_record = ?, live_notification_enabled = ?, upload_enabled = ?, title_source = ?, title_updated_at = ?, title_fallback_used = ?, monitor_state = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.url,
          next.displayName,
          next.enabled ? 1 : 0,
          next.favorited ? 1 : 0,
          next.autoRecord === null ? null : next.autoRecord ? 1 : 0,
          next.liveNotificationEnabled ? 1 : 0,
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

  reorder(roomIds: string[]): Room[] {
    return this.db.transaction(() => {
      const current = this.list().map((room) => room.id);
      const requested = new Set(roomIds);
      if (
        roomIds.length !== current.length ||
        requested.size !== roomIds.length ||
        current.some((id) => !requested.has(id))
      ) {
        throw new AppError('CONFIG_INVALID', 'roomIds 必须是当前全部直播间 ID 的无重复完整排列');
      }
      const update = this.db.prepare('UPDATE rooms SET sort_order = ? WHERE id = ?');
      roomIds.forEach((id, index) => update.run(index, id));
      return this.list();
    })();
  }

  setState(id: string, state: MonitorState, opts: { lastCheckedAt?: string; lastError?: ErrorObject | null } = {}): void {
    this.db
      .prepare(
        `UPDATE rooms SET monitor_state = ?, last_checked_at = COALESCE(?, last_checked_at), last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(state, opts.lastCheckedAt ?? null, opts.lastError ? JSON.stringify(opts.lastError) : null, nowIso(), id);
  }

  /** 写入平台级错误但保留录制等现有状态，避免中断正在进行的录制。 */
  setLastError(id: string, error: ErrorObject): void {
    this.db
      .prepare('UPDATE rooms SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(error), nowIso(), id);
  }

  /**
   * 写入最近一次检测的直播状态。liveStartedAt 是本地确认的开播周期边界：
   * offline 会清空它；live 则仅在尚无边界时写入，避免每次轮询扩大去重范围。
   */
  setLiveStatus(id: string, status: LiveStatus, liveStartedAt?: string): void {
    this.db
      .prepare(`UPDATE rooms
        SET last_live_status = ?,
            live_started_at = CASE
              WHEN ? = 'offline' THEN NULL
              WHEN ? = 'live' THEN COALESCE(live_started_at, ?)
              ELSE live_started_at
            END,
            updated_at = ?
        WHERE id = ?`)
      .run(status, status, status, liveStartedAt ?? null, nowIso(), id);
  }

  /** 保存本次检测到的可录清晰度；空数组表示未知（未开播/平台未给出），不展示过期的「最高可录」。 */
  setAvailableQualities(id: string, qualities: Quality[]): void {
    this.db
      .prepare(`UPDATE rooms SET available_qualities = ?, updated_at = ? WHERE id = ?`)
      .run(qualities.length > 0 ? JSON.stringify(qualities) : null, nowIso(), id);
  }

  /** 保存本场直播的房间标题；离线/受限时清除，避免展示过期标题。 */
  setCurrentStreamTitle(id: string, title: string | null): void {
    this.db
      .prepare(`UPDATE rooms SET current_stream_title = ?, updated_at = ? WHERE id = ?`)
      .run(title?.trim() || null, nowIso(), id);
  }

  /** 写入房间标题识别元数据（V5 #91：识别来源/时间/回退标记）。 */
  setTitleInfo(id: string, info: { titleSource: TitleSource; titleFallbackUsed: boolean }): void {
    this.db
      .prepare(`UPDATE rooms SET title_source = ?, title_updated_at = ?, title_fallback_used = ?, updated_at = ? WHERE id = ?`)
      .run(info.titleSource, nowIso(), info.titleFallbackUsed ? 1 : 0, nowIso(), id);
  }

  remove(id: string): void {
    // #92：仅移除监控配置，不再级联删除该房间的录制历史（迁移 v8 已去掉外键）。
    // 检测事件仅服务于仍存在的监控项，删除房间时一并移除，避免外键阻塞删除。
    this.db.prepare('DELETE FROM live_events WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM prediction_forecasts WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM prediction_coverage WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM prediction_coverage_intervals WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM prediction_recording_sessions WHERE room_id = ?').run(id);
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }
}

export function isUniqueConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    String((err as { message?: string }).message ?? '').includes('UNIQUE constraint failed: rooms.platform, rooms.url');
}
