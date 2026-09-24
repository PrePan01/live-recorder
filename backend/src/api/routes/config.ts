import { writeFile } from 'node:fs/promises';
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
  settings: Awaited<ReturnType<typeof settingsView>>;
  rooms: ReturnType<Services['rooms']['list']>;
  alerts: ReturnType<Services['alerts']['list']>;
  /** 已结束录制的历史元数据（不含录像文件），供恢复录制历史与统计看板。 */
  recordings: RecordingArchive;
  /** 开播预测的样本与校准数据；按 platform+url 归属，导入时映射到本地房间。 */
  prediction: PredictionArchive;
}

export interface ImportConfigInput {
  version?: number;
  settings?: Partial<AppSettings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean }>;
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
  recordings?: unknown;
  prediction?: unknown;
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
      if (!group || (group.platform !== 'bilibili' && group.platform !== 'douyin') || typeof group.url !== 'string') continue;
      const room = roomsByUrl.get(`${group.platform}|${group.url}`);
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
    rooms: services.rooms.list(),
    alerts: services.alerts.list(),
    recordings: exportRecordingArchive(services),
    prediction: exportPredictionArchive(services),
  };
}

/** 把导出内容写入指定路径，返回实际写入的文件名。 */
export async function exportConfigToPath(services: Services, target: string): Promise<string> {
  const filePath = /\.json$/i.test(target) ? target : `${target}.json`;
  const payload = `${JSON.stringify({ config: await buildExportConfig(services) }, null, 2)}\n`;
  await writeFile(filePath, payload, 'utf8');
  return filePath;
}

export function registerConfigRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/config/export', async (_req, reply) => {
    return reply.send({ config: await buildExportConfig(services) });
  });

  app.post('/api/v1/config/export-file', async (_req, reply) => {
    if (process.env.VITEST === 'true') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    const picked = await nativePickSaveFile(`live-recorder-config-${services.clock.iso().slice(0, 10)}.json`);
    if (picked.status === 'unsupported') return reply.send({ ok: true, saved: false, path: null, reason: 'no-dialog' });
    if (picked.status === 'cancelled') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    try {
      const filePath = await exportConfigToPath(services, picked.path);
      return reply.send({ ok: true, saved: true, path: filePath, reason: null });
    } catch {
      throw new AppError('CONFIG_EXPORT_FAILED', '无法写入所选位置');
    }
  });

  app.post('/api/v1/config/import', async (req, reply) => {
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
        mail: { ...current.mail, ...incoming.settings.mail } as AppSettings['mail'],
      };
      validateSettings(merged);
      services.settings.save(merged);
      appliedSettings = true;
    }
    let importedRooms = 0;
    let skippedRooms = 0;
    if (Array.isArray(incoming.rooms)) {
      const existing = new Set(services.rooms.list().map((r) => `${r.platform}|${r.url}`));
      try {
        for (const item of incoming.rooms) {
          if (!item || typeof item.url !== 'string' || (item.platform !== 'bilibili' && item.platform !== 'douyin')) continue;
          const key = `${item.platform}|${item.url}`;
          if (existing.has(key)) {
            skippedRooms += 1;
            continue;
          }
          services.rooms.create({
            platform: item.platform as Platform,
            url: item.url,
            displayName: typeof item.displayName === 'string' ? item.displayName : '',
            enabled: item.enabled ?? true,
          });
          existing.add(key);
          importedRooms += 1;
        }
      } catch (err) {
        throw new AppError('CONFIG_LOAD_FAILED', '房间导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
      }
    }
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
        prediction = importPredictionArchive(services, incoming.prediction);
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
