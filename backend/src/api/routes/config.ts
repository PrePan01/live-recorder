import { validateRoomPolicy, type RoomPolicyPatch } from '../../config/room-policy.js';
import { saveXiaohongshuSource } from '../../platform/xiaohongshu-source-store.js';
import { writeFile } from 'node:fs/promises';
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from '../../platform/xiaohongshu-url.js';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { AppSettings, Platform } from '../../types/index.js';
import type { Services } from '../../core/services.js';
import { validateSettings } from '../../config/schema.js';
import { settingsView } from './settings-view.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import { nativePickSaveFile } from './settings.js';
import { exportPredictionArchive, importPredictionArchive, type PredictionArchive, type PredictionImportSummary } from '../../core/prediction-archive.js';

interface RecordingArchiveEntry {
  id: string;
  startedAt: string;
  endedAt: string | null;
  streamSessionId: string | null;
  streamTitle: string;
  roomName: string;
  state: 'completed' | 'failed';
  fileSizeBytes: number;
  retryCount: number;
  quality: string | null;
  integrity: string | null;
  createdAt: string;
}

interface RecordingArchive {
  /** 房间内部 ID 在不同安装间不稳定，因此使用 platform+url 重新归属。 */
  rooms: Array<{ platform: Platform; url: string; recordings: RecordingArchiveEntry[] }>;
}

interface RecordingImportSummary {
  matchedRooms: number;
  skippedRooms: number;
  recordings: number;
}

export interface ExportConfig {
  version: 1;
  exportedAt: string;
  appearance?: { showStatusBarAlerts?: boolean; showLiveRoomCover?: boolean };
  settings: Awaited<ReturnType<typeof settingsView>>;
  rooms: ReturnType<Services['rooms']['list']>;
  tags: ReturnType<Services['tags']['list']>;
  alerts: ReturnType<Services['alerts']['list']>;
  /** 已结束录制的历史元数据（不含录像文件），供恢复录制历史与统计看板。 */
  recordings: RecordingArchive;
  /** 开播预测的样本与校准数据；按 platform+url 归属，导入时映射到本地房间。 */
  prediction: PredictionArchive;
  xiaohongshuSources: Array<{ profileUrl: string; roomUrl: string; profileRequestUrl?: string | null }>;
}

export interface ImportConfigInput {
  version?: number;
  settings?: Partial<AppSettings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean; danmakuEnabled?: boolean | null; tags?: unknown[] } & RoomPolicyPatch>;
  tags?: unknown[];
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
  recordings?: unknown;
  prediction?: unknown;
  xiaohongshuSources?: ExportConfig['xiaohongshuSources'];
}

/** Resolve legacy backup profile keys without making network requests. */
function persistedRoomUrl(services: Services, platform: string, url: string): string {
  if (platform !== 'xiaohongshu' || parseXiaohongshuUrl(url)?.kind !== 'profile') return url;
  const source = services.db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url=?').get(normalizeXiaohongshuUrl(url)) as { room_url: string } | undefined;
  return source && parseXiaohongshuUrl(source.room_url)?.kind === 'room' ? normalizeXiaohongshuUrl(source.room_url) : url;
}

function validMoment(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null;
}

/** 导出已结束录制的元数据；录像文件路径不跨机器搬运。 */
function exportRecordingArchive(services: Services): RecordingArchive {
  const byRoom = new Map(
    services.rooms.list().map((room) => [
      room.id,
      { platform: room.platform, url: room.url, recordings: [] as RecordingArchiveEntry[] },
    ]),
  );
  const rows = services.db
    .prepare(
      `SELECT id, room_id AS roomId, started_at AS startedAt, ended_at AS endedAt,
              stream_session_id AS streamSessionId, stream_title AS streamTitle,
              room_name AS roomName, state, file_size_bytes AS fileSizeBytes,
              retry_count AS retryCount, quality, integrity, created_at AS createdAt
       FROM recordings WHERE state IN ('completed', 'failed') ORDER BY started_at, id`,
    )
    .all() as Array<RecordingArchiveEntry & { roomId: string }>;
  for (const row of rows) {
    const room = byRoom.get(row.roomId);
    if (!room) continue;
    room.recordings.push({
      id: row.id,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      streamSessionId: row.streamSessionId,
      streamTitle: row.streamTitle ?? '',
      roomName: row.roomName ?? '',
      state: row.state,
      fileSizeBytes: Math.max(0, row.fileSizeBytes ?? 0),
      retryCount: Math.max(0, row.retryCount ?? 0),
      quality: row.quality ?? null,
      integrity: row.integrity ?? null,
      createdAt: row.createdAt,
    });
  }
  return { rooms: [...byRoom.values()].filter((room) => room.recordings.length > 0) };
}

/** 恢复历史元数据。保留源 recording ID，使重复导入同一备份保持幂等。 */
function importRecordingArchive(services: Services, input: unknown): RecordingImportSummary {
  const summary: RecordingImportSummary = { matchedRooms: 0, skippedRooms: 0, recordings: 0 };
  const groups = (input as RecordingArchive | null)?.rooms;
  if (!Array.isArray(groups)) return summary;
  const roomsByUrl = new Map(services.rooms.list().map((room) => [`${room.platform}|${room.url}`, room]));
  const insert = services.db.prepare(
    `INSERT OR IGNORE INTO recordings
      (id, room_id, room_name, platform, stream_session_id, stream_title, state,
       started_at, ended_at, file_size_bytes, retry_count, quality, integrity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  services.db.transaction(() => {
    for (const group of groups) {
      if (!group || (group.platform !== 'bilibili' && group.platform !== 'douyin' && group.platform !== 'xiaohongshu') || typeof group.url !== 'string') continue;
      const room = roomsByUrl.get(`${group.platform}|${persistedRoomUrl(services, group.platform, group.url)}`);
      if (!room) {
        summary.skippedRooms += 1;
        continue;
      }
      summary.matchedRooms += 1;
      if (!Array.isArray(group.recordings)) continue;
      for (const record of group.recordings) {
        const startedAt = validMoment(record?.startedAt);
        const endedAt = record?.endedAt === null ? null : validMoment(record?.endedAt);
        if (
          typeof record?.id !== 'string' ||
          record.id.length === 0 ||
          !startedAt ||
          (record.endedAt !== null && !endedAt) ||
          (record.state !== 'completed' && record.state !== 'failed')
        ) continue;
        const fileSizeBytes = typeof record.fileSizeBytes === 'number' && Number.isFinite(record.fileSizeBytes)
          ? Math.max(0, Math.trunc(record.fileSizeBytes))
          : 0;
        const retryCount = typeof record.retryCount === 'number' && Number.isFinite(record.retryCount)
          ? Math.max(0, Math.trunc(record.retryCount))
          : 0;
        const inserted = insert.run(
          record.id,
          room.id,
          typeof record.roomName === 'string' ? record.roomName : room.displayName,
          room.platform,
          typeof record.streamSessionId === 'string' ? record.streamSessionId : null,
          typeof record.streamTitle === 'string' ? record.streamTitle : '',
          record.state,
          startedAt,
          endedAt,
          fileSizeBytes,
          retryCount,
          typeof record.quality === 'string' ? record.quality : null,
          typeof record.integrity === 'string' ? record.integrity : null,
          validMoment(record.createdAt) ?? startedAt,
        );
        if (inserted.changes > 0) summary.recordings += 1;
      }
    }
  })();
  return summary;
}

async function buildExportConfig(services: Services): Promise<ExportConfig> {
  return {
    version: 1,
    exportedAt: services.clock.iso(),
    settings: await settingsView(services),
    rooms: services.rooms.list().map(room => ({ ...room, liveEmailNotificationEnabled: false })),
    tags: services.tags.list(),
    alerts: services.alerts.list(),
    recordings: exportRecordingArchive(services),
    prediction: exportPredictionArchive(services),
    xiaohongshuSources: services.db.prepare(`SELECT s.profile_url AS profileUrl, s.room_url AS roomUrl, s.profile_request_url AS profileRequestUrl FROM xiaohongshu_sources s
      JOIN rooms r ON r.platform='xiaohongshu' AND (r.url=s.profile_url OR r.url=s.room_url)`).all() as ExportConfig['xiaohongshuSources'],
  };
}

/** 把导出内容写入指定路径，返回实际写入的文件名。 */
export async function exportConfigToPath(services: Services, target: string, appearance?: unknown): Promise<string> {
  const filePath = /\.json$/i.test(target) ? target : `${target}.json`;
  const config = await buildExportConfig(services);
  const showStatusBarAlerts = (appearance as { showStatusBarAlerts?: unknown } | null)?.showStatusBarAlerts;
  if (typeof showStatusBarAlerts === 'boolean') {
    config.appearance = { showStatusBarAlerts };
  }
  const showLiveRoomCover = (appearance as { showLiveRoomCover?: unknown } | null)?.showLiveRoomCover;
  if (typeof showLiveRoomCover === 'boolean') {
    config.appearance = { ...config.appearance, showLiveRoomCover };
  }
  const payload = `${JSON.stringify({ config }, null, 2)}\n`;
  await writeFile(filePath, payload, 'utf8');
  return filePath;
}

export function registerConfigRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/config/export', async (_req, reply) => {
    return reply.send({ config: await buildExportConfig(services) });
  });

  app.post('/api/v1/config/export-file', async (req, reply) => {
    if (process.env.VITEST === 'true') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    const picked = await nativePickSaveFile(`live-recorder-config-${services.clock.iso().slice(0, 10)}.json`);
    if (picked.status === 'unsupported') return reply.send({ ok: true, saved: false, path: null, reason: 'no-dialog' });
    if (picked.status === 'cancelled') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    try {
      const { appearance } = (req.body ?? {}) as { appearance?: unknown };
      const filePath = await exportConfigToPath(services, picked.path, appearance);
      return reply.send({ ok: true, saved: true, path: filePath, reason: null });
    } catch {
      throw new AppError('CONFIG_EXPORT_FAILED', '无法写入所选位置');
    }
  });

  // 备份文件随录制历史线性增大（数千条即超默认 1MiB）：单路由放宽到 64MiB，
  // 超限由 errorHandler 归为 413 友好提示（此前落 500 误导排查方向）。
  app.post(
    '/api/v1/config/import',
    { bodyLimit: 64 * 1024 * 1024 },
    async (req, reply) => {
      const body = (req.body ?? {}) as { config?: ImportConfigInput };
    const incoming = body.config;
    if (!incoming || typeof incoming !== 'object') {
      throw new AppError('CONFIG_LOAD_FAILED', '导入内容缺失');
    }
    let appliedSettings = false;
    if (incoming.settings !== undefined) {
      const current = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
      const merged: AppSettings = {
        ...current,
        ...incoming.settings,
        checkIntervalSec: { xiaohongshu: 120, ...current.checkIntervalSec, ...incoming.settings.checkIntervalSec },
        mail: { ...current.mail, ...incoming.settings.mail } as AppSettings['mail'],
      };
      delete (merged as unknown as Record<string, unknown>).xiaohongshuCookie;
      validateSettings(merged);
      services.settings.save(merged);
      appliedSettings = true;
    }
    let importedRooms = 0;
    let skippedRooms = 0;
    // 标签 ID 只在源安装内有效；按名称复用本地标签，兼容旧备份的 rooms[].tags。
    const restoreTag = (input: unknown): string | null => {
      if (!input || typeof input !== 'object') return null;
      const tag = input as { name?: unknown; color?: unknown };
      const name = typeof tag.name === 'string' ? tag.name.trim() : '';
      if (!name || name.length > 30) return null;
      const existing = services.tags.findByName(name);
      if (existing) return existing.id;
      const color = typeof tag.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(tag.color) ? tag.color : '#1677ff';
      return services.tags.create({ name, color }).id;
    };
    if (Array.isArray(incoming.tags)) {
      try {
        services.db.transaction(() => {
          for (const tag of incoming.tags!) restoreTag(tag);
        })();
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '标签导入失败', { details: { appliedSettings } });
      }
    }
    if (Array.isArray(incoming.xiaohongshuSources)) {
      for (const source of incoming.xiaohongshuSources) {
        if (typeof source?.profileUrl !== 'string' || typeof source.roomUrl !== 'string' || parseXiaohongshuUrl(source.profileUrl)?.kind !== 'profile') continue;
        const canonical = normalizeXiaohongshuUrl(source.profileUrl);
        const profileRequest = typeof source.profileRequestUrl === 'string' && parseXiaohongshuUrl(source.profileRequestUrl)?.kind === 'profile' &&
          normalizeXiaohongshuUrl(source.profileRequestUrl) === canonical ? source.profileRequestUrl : null;
        if (parseXiaohongshuUrl(source.roomUrl)?.kind !== 'room' && !(source.roomUrl === '' && profileRequest)) continue;
        saveXiaohongshuSource(services.db, canonical, source.roomUrl);
        services.db.prepare('INSERT INTO xiaohongshu_sources (profile_url,room_url,profile_request_url) VALUES (?,?,?) ON CONFLICT(profile_url) DO UPDATE SET room_url=excluded.room_url, profile_request_url=COALESCE(excluded.profile_request_url,xiaohongshu_sources.profile_request_url)')
          .run(canonical, source.roomUrl ? normalizeXiaohongshuUrl(source.roomUrl) : '', profileRequest);
      }
    }
    if (Array.isArray(incoming.rooms)) {
      const existing = new Map(services.rooms.list().map((r) => [`${r.platform}|${r.url}`, r]));
      try {
        for (const item of incoming.rooms) {
          if (!item || typeof item.url !== 'string' || (item.platform !== 'bilibili' && item.platform !== 'douyin' && item.platform !== 'xiaohongshu')) continue;
          const policy = validateRoomPolicy({ ...item });
          // 旧版备份可能仅订阅邮件；新版将其并入开播提醒，废弃位不再保留为开启状态。
          if (policy.liveEmailNotificationEnabled === true) policy.liveNotificationEnabled = true;
          if (policy.liveEmailNotificationEnabled !== undefined) policy.liveEmailNotificationEnabled = false;
          const url = persistedRoomUrl(services, item.platform, item.url);
          const key = `${item.platform}|${url}`;
          let room = existing.get(key);
          if (room) skippedRooms += 1;
          else {
            room = services.rooms.create({
              platform: item.platform as Platform,
              url,
              displayName: typeof item.displayName === 'string' ? item.displayName : '',
              enabled: item.enabled ?? true,
            });
            existing.set(key, room);
            importedRooms += 1;
          }
          if (Object.keys(policy).length) services.rooms.update(room.id, policy);
          if (Array.isArray(item.tags)) {
            const roomId = room.id;
            services.db.transaction(() => {
              // 合并已有房间的关联，重复导入不清除本地标签或产生重复关联。
              const ids = new Set(services.tags.tagsForRoom(roomId).map((tag) => tag.id));
              for (const tag of item.tags!) {
                const id = restoreTag(tag);
                if (id) ids.add(id);
              }
              services.tags.setRoomTags(roomId, [...ids]);
            })();
          }
        }
      } catch (err) {
        throw new AppError('CONFIG_LOAD_FAILED', '房间导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
      }
    }
    services.scheduler.reschedule();
    let recordings: RecordingImportSummary | null = null;
    if (incoming.recordings !== undefined) {
      try {
        recordings = importRecordingArchive(services, incoming.recordings);
        services.statsCache = undefined;
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '录制历史导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
      }
    }
    // 预测数据必须排在房间导入之后：房间先落地，样本才能按 platform+url 找到归属。
    let prediction: PredictionImportSummary | null = null;
    if (incoming.prediction !== undefined) {
      try {
        const archive = incoming.prediction as { rooms?: unknown } | null;
        const normalized = Array.isArray(archive?.rooms) ? { ...archive, rooms: archive.rooms.map(group => {
          if (!group || typeof group.platform !== 'string' || typeof group.url !== 'string') return group;
          return { ...group, url: persistedRoomUrl(services, group.platform, group.url) };
        }) } : incoming.prediction;
        prediction = importPredictionArchive(services, normalized);
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '开播预测数据导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
      }
    }
    let importedAlerts = 0;
    if (Array.isArray(incoming.alerts)) {
      try {
        for (const a of incoming.alerts) {
          if (!a || typeof a.message !== 'string' || a.resolved === true) continue;
          const level = a.level === 'error' || a.level === 'warning' ? a.level : 'info';
          services.alerts.create({ level, source: typeof a.source === 'string' ? a.source : 'import', message: a.message, occurredAt: typeof a.occurredAt === 'string' ? a.occurredAt : services.clock.iso() });
          importedAlerts += 1;
        }
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '告警导入失败', { details: { appliedSettings, importedRooms, skippedRooms, importedAlerts } });
      }
    }
    if (appliedSettings) {
      services.events.emit({ type: 'settings:updated', data: await settingsView(services) });
    }
    return reply.send({ ok: true, appliedSettings, importedRooms, skippedRooms, importedAlerts, recordings, prediction });
  });
}
