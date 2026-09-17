import { newId } from '../utils/id.js';
import type { Platform } from '../types/index.js';
import type { Services } from './services.js';

export type PredictionConfidenceValue = 'high' | 'medium' | 'low';
export type PredictionOutcomeValue = 'hit' | 'miss' | 'unknown';
export const LIVE_EVENT_SOURCES = ['platform', 'transition', 'initial_live', 'legacy'] as const;

/**
 * 开播预测的样本与校准数据。归属用 platform+url 标识而不是内部 room_id：
 * 换机或重置后房间会重新建号，room_id 不再指向同一个直播间。
 */
export interface PredictionArchiveRoom {
  platform: Platform;
  url: string;
  /** 开播观测（正样本）。id 是原库行标识，导入以它判重，才能原样还原（含同房间同毫秒的多条）。 */
  events: Array<{ id: string; detectedAt: string; source: string; lowerBoundAt: string | null; platformStartedAt: string | null }>;
  /** 历史预测与事后命中结果（置信度校准）。 */
  forecasts: Array<{
    targetDate: string;
    probability: PredictionConfidenceValue;
    generatedAt: string;
    outcome: PredictionOutcomeValue | null;
    resolvedAt: string | null;
    rawProbability: PredictionConfidenceValue | null;
    windowStartAt: string | null;
    windowEndAt: string | null;
  }>;
  /** 每日检测覆盖计数。 */
  coverage: Array<{ targetDate: string; firstCheckedAt: string; lastCheckedAt: string; checks: number }>;
  /** 检测覆盖区间（负样本证据：这些时段确实盯着且没开播）。 */
  intervals: Array<{ startAt: string; endAt: string }>;
  /**
   * 录制起点（弱开播证据）。它本来来自录制历史，而录制历史不搬运，
   * 所以单独带一份，否则换机后预测会比原机器少几天样本、算不出同样的结果。
   */
  recordingSessions: Array<{ startedAt: string; streamSessionId: string | null }>;
}

export interface PredictionArchive {
  rooms: PredictionArchiveRoom[];
}

export interface PredictionImportSummary {
  matchedRooms: number;
  skippedRooms: number;
  events: number;
  forecasts: number;
  coverage: number;
  intervals: number;
  recordingSessions: number;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function moment(value: unknown): string | null {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 导出全部预测数据（不做时间裁剪：导入端需要拿到完整历史）。 */
export function exportPredictionArchive(services: Services): PredictionArchive {
  const archive = new Map<string, PredictionArchiveRoom>();
  for (const room of services.rooms.list()) {
    archive.set(room.id, { platform: room.platform, url: room.url, events: [], forecasts: [], coverage: [], intervals: [], recordingSessions: [] });
  }
  // 已删除房间遗留的观测拿不回归属，跳过（重置/删除房间都会连带清理）。
  const events = services.db
    .prepare('SELECT id, room_id AS roomId, detected_at AS detectedAt, source, lower_bound_at AS lowerBoundAt, platform_started_at AS platformStartedAt FROM live_events ORDER BY detected_at')
    .all() as Array<{ id: string; roomId: string; detectedAt: string; source: string; lowerBoundAt: string | null; platformStartedAt: string | null }>;
  for (const event of events) {
    const room = archive.get(event.roomId);
    if (!room) continue;
    room.events.push({
      id: event.id,
      detectedAt: event.detectedAt,
      source: event.source,
      lowerBoundAt: event.lowerBoundAt,
      platformStartedAt: event.platformStartedAt,
    });
  }
  const forecasts = services.db
    .prepare(
      'SELECT room_id AS roomId, target_date AS targetDate, probability, generated_at AS generatedAt, outcome, resolved_at AS resolvedAt, raw_probability AS rawProbability, window_start_at AS windowStartAt, window_end_at AS windowEndAt FROM prediction_forecasts ORDER BY target_date',
    )
    .all() as Array<{ roomId: string; targetDate: string; probability: PredictionConfidenceValue; generatedAt: string; outcome: PredictionOutcomeValue | null; resolvedAt: string | null; rawProbability: PredictionConfidenceValue | null; windowStartAt: string | null; windowEndAt: string | null }>;
  for (const forecast of forecasts) {
    const room = archive.get(forecast.roomId);
    if (!room) continue;
    room.forecasts.push({
      targetDate: forecast.targetDate,
      probability: forecast.probability,
      generatedAt: forecast.generatedAt,
      outcome: forecast.outcome,
      resolvedAt: forecast.resolvedAt,
      rawProbability: forecast.rawProbability,
      windowStartAt: forecast.windowStartAt,
      windowEndAt: forecast.windowEndAt,
    });
  }
  const coverage = services.db
    .prepare('SELECT room_id AS roomId, target_date AS targetDate, first_checked_at AS firstCheckedAt, last_checked_at AS lastCheckedAt, checks FROM prediction_coverage ORDER BY target_date')
    .all() as Array<{ roomId: string; targetDate: string; firstCheckedAt: string; lastCheckedAt: string; checks: number }>;
  for (const day of coverage) {
    const room = archive.get(day.roomId);
    if (!room) continue;
    room.coverage.push({
      targetDate: day.targetDate,
      firstCheckedAt: day.firstCheckedAt,
      lastCheckedAt: day.lastCheckedAt,
      checks: day.checks,
    });
  }
  const intervals = services.db
    .prepare('SELECT room_id AS roomId, start_at AS startAt, end_at AS endAt FROM prediction_coverage_intervals ORDER BY start_at')
    .all() as Array<{ roomId: string; startAt: string; endAt: string }>;
  for (const interval of intervals) {
    const room = archive.get(interval.roomId);
    if (!room) continue;
    room.intervals.push({ startAt: interval.startAt, endAt: interval.endAt });
  }
  // 录制起点证据 = 本机录制历史（只取预测会读的 60 天，避免把整份录制历史塞进文件）+ 之前导入进来的证据。
  const seenSessions = new Set<string>();
  const addSession = (roomId: string, startedAt: string, streamSessionId: string | null) => {
    const room = archive.get(roomId);
    const key = `${roomId}|${startedAt}`;
    if (!room || seenSessions.has(key)) return;
    seenSessions.add(key);
    room.recordingSessions.push({ startedAt, streamSessionId });
  };
  const from60 = new Date(services.clock.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const recordedStarts = services.db
    .prepare('SELECT room_id AS roomId, started_at AS startedAt, stream_session_id AS streamSessionId FROM recordings WHERE started_at >= ? ORDER BY started_at')
    .all(from60) as Array<{ roomId: string; startedAt: string; streamSessionId: string | null }>;
  for (const session of [...recordedStarts, ...services.predictionCalibration.allRecordingSessions()]) {
    addSession(session.roomId, session.startedAt, session.streamSessionId);
  }
  return {
    rooms: [...archive.values()].filter(
      (room) => room.events.length + room.forecasts.length + room.coverage.length + room.intervals.length + room.recordingSessions.length > 0,
    ),
  };
}

/**
 * 导入预测数据。房间按 platform+url 映射到本地房间；同一份文件重复导入不会改变预测结果：
 * 观测按 (room, 检测时间) 去重，预测与覆盖区间靠唯一键忽略重复，覆盖计数取最大值而不是累加。
 */
export function importPredictionArchive(services: Services, input: unknown): PredictionImportSummary {
  const summary: PredictionImportSummary = { matchedRooms: 0, skippedRooms: 0, events: 0, forecasts: 0, coverage: 0, intervals: 0, recordingSessions: 0 };
  const groups = rows<PredictionArchiveRoom>((input as PredictionArchive | null)?.rooms);
  if (groups.length === 0) return summary;

  const roomIdByUrl = new Map(services.rooms.list().map((room) => [`${room.platform}|${room.url}`, room.id] as const));
  // 按源库行 id 判重：重复导入是 no-op，同房间同毫秒的多条观测也能原样保留。
  const insertEvent = services.db.prepare(
    'INSERT OR IGNORE INTO live_events (id, room_id, detected_at, source, lower_bound_at, platform_started_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertForecast = services.db.prepare(
    `INSERT OR IGNORE INTO prediction_forecasts (room_id, target_date, probability, generated_at, outcome, resolved_at, raw_probability, window_start_at, window_end_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const mergeCoverage = services.db.prepare(
    `INSERT INTO prediction_coverage (room_id, target_date, first_checked_at, last_checked_at, checks)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, target_date) DO UPDATE SET
       first_checked_at = MIN(prediction_coverage.first_checked_at, excluded.first_checked_at),
       last_checked_at = MAX(prediction_coverage.last_checked_at, excluded.last_checked_at),
       checks = MAX(prediction_coverage.checks, excluded.checks)`,
  );
  const insertInterval = services.db.prepare(
    'INSERT OR IGNORE INTO prediction_coverage_intervals (room_id, start_at, end_at) VALUES (?, ?, ?)',
  );

  services.db.transaction(() => {
    for (const group of groups) {
      const roomId = typeof group?.url === 'string' ? roomIdByUrl.get(`${group.platform}|${group.url}`) : undefined;
      if (!roomId) {
        summary.skippedRooms += 1;
        continue;
      }
      summary.matchedRooms += 1;
      for (const event of rows<PredictionArchiveRoom['events'][number]>(group.events)) {
        const detectedAt = moment(event?.detectedAt);
        if (!detectedAt) continue;
        const inserted = insertEvent.run(
          text(event?.id) ?? newId('lev'),
          roomId,
          detectedAt,
          oneOf(event?.source, LIVE_EVENT_SOURCES) ?? 'legacy',
          moment(event?.lowerBoundAt),
          moment(event?.platformStartedAt),
        );
        if (inserted.changes > 0) summary.events += 1;
      }
      for (const forecast of rows<PredictionArchiveRoom['forecasts'][number]>(group.forecasts)) {
        const targetDate = moment(forecast?.targetDate);
        const generatedAt = moment(forecast?.generatedAt);
        const probability = oneOf(forecast?.probability, ['high', 'medium', 'low'] as const);
        const rawOutcome = forecast?.outcome ?? null;
        const outcome = rawOutcome === null ? null : oneOf(rawOutcome, ['hit', 'miss', 'unknown'] as const);
        // 取值非法时丢掉整行，不用默认值替用户编造一条预测结果。
        if (!targetDate || !generatedAt || !probability || (rawOutcome !== null && outcome === null)) continue;
        const inserted = insertForecast.run(
          roomId,
          targetDate,
          probability,
          generatedAt,
          outcome,
          moment(forecast?.resolvedAt),
          oneOf(forecast?.rawProbability, ['high', 'medium', 'low'] as const),
          moment(forecast?.windowStartAt),
          moment(forecast?.windowEndAt),
        );
        if (inserted.changes > 0) summary.forecasts += 1;
      }
      for (const day of rows<PredictionArchiveRoom['coverage'][number]>(group.coverage)) {
        const targetDate = moment(day?.targetDate);
        const firstCheckedAt = moment(day?.firstCheckedAt);
        const lastCheckedAt = moment(day?.lastCheckedAt);
        if (!targetDate || !firstCheckedAt || !lastCheckedAt || typeof day?.checks !== 'number' || !Number.isFinite(day.checks)) continue;
        mergeCoverage.run(roomId, targetDate, firstCheckedAt, lastCheckedAt, Math.max(0, Math.trunc(day.checks)));
        summary.coverage += 1;
      }
      for (const interval of rows<PredictionArchiveRoom['intervals'][number]>(group.intervals)) {
        const startAt = moment(interval?.startAt);
        const endAt = moment(interval?.endAt);
        if (!startAt || !endAt || Date.parse(endAt) < Date.parse(startAt)) continue;
        const inserted = insertInterval.run(roomId, startAt, endAt);
        if (inserted.changes > 0) summary.intervals += 1;
      }
      for (const session of rows<PredictionArchiveRoom['recordingSessions'][number]>(group.recordingSessions)) {
        const startedAt = moment(session?.startedAt);
        if (!startedAt) continue;
        if (services.predictionCalibration.recordRecordingSession(roomId, startedAt, text(session?.streamSessionId))) summary.recordingSessions += 1;
      }
    }
  })();

  return summary;
}
