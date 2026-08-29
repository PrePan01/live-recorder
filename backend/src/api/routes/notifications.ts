import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import { DEFAULT_NOTIFICATION_PREFERENCE, type NotificationPreference } from '../../types/index.js';
import type { AppSettings } from '../../types/index.js';

/** 预测样本窗口：近 30 天；样本不足 3 天则无预测（返回提示）。 */
const PREDICTION_WINDOW_DAYS = 30;
const MIN_SAMPLE_DAYS = 3;

export type PredictionConfidence = 'high' | 'medium' | 'low';

/** V5 通知偏好读写（GET/PUT /settings/notifications，随 settings 存储）。 */
export function notificationPreference(services: Services): NotificationPreference {
  const settings = services.settings.load() as AppSettings | null;
  const stored = settings?.notifications;
  return { ...DEFAULT_NOTIFICATION_PREFERENCE, ...(stored ?? {}) };
}

/**
 * V5 开播预测：只读近 30 天录制/开播事实，按「最早开始-最晚结束」聚合典型开播窗口。
 * 返回 { roomId, startAt, endAt, confidence, basedOnDays }；样本不足返回 confidence=null + notice。
 */
export function livePrediction(services: Services, roomId: string): {
  roomId: string;
  startAt: string | null;
  endAt: string | null;
  confidence: PredictionConfidence | null;
  basedOnDays: number;
  notice: string | null;
  generatedAt: string;
} {
  const from = new Date(services.clock.now() - PREDICTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recs = services.recordings.list({ roomId, pageSize: 500, dateFrom: from, groupBy: 'session' }).items;
  // 按天聚合每场最早开始与最晚结束（当日直播窗口）。
  const byDay = new Map<string, { start: number; end: number }>();
  for (const r of recs) {
    if (!r.endedAt || !r.startedAt) continue;
    const day = r.startedAt.slice(0, 10);
    const start = new Date(r.startedAt).getTime();
    const end = new Date(r.endedAt).getTime();
    const cur = byDay.get(day);
    if (!cur) {
      byDay.set(day, { start, end });
    } else {
      cur.start = Math.min(cur.start, start);
      cur.end = Math.max(cur.end, end);
    }
  }
  const days = [...byDay.values()].sort((a, b) => a.start - b.start);
  const generatedAt = services.clock.iso();
  if (days.length < MIN_SAMPLE_DAYS) {
    return { roomId, startAt: null, endAt: null, confidence: null, basedOnDays: days.length, notice: '近 30 天样本不足，暂无开播预测', generatedAt };
  }
  // 中位数起始/结束（抗离群），转本地时区 HH:MM。
  const startMs = median(days.map((d) => d.start));
  const endMs = median(days.map((d) => d.end));
  // 置信度按样本天数：≥10 高、≥5 中、≥3 低。
  const confidence: PredictionConfidence = days.length >= 10 ? 'high' : days.length >= 5 ? 'medium' : 'low';
  return {
    roomId,
    startAt: hhmm(startMs),
    endAt: hhmm(endMs),
    confidence,
    basedOnDays: days.length,
    notice: null,
    generatedAt,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function registerNotificationRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings/notifications', async (_req, reply) => {
    return reply.send({ notifications: notificationPreference(services) });
  });

  app.put('/api/v1/settings/notifications', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<NotificationPreference>;
    const current = notificationPreference(services);
    const merged: NotificationPreference = { ...current, ...body };
    const err = validateNotifications(merged);
    if (err) throw err;
    const settings = services.settings.load() as AppSettings | null;
    const base = settings ?? ({ recordingDirectory: '' } as AppSettings);
    services.settings.save({ ...base, notifications: merged } as AppSettings);
    const view = await (await import('./settings-view.js')).settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ notifications: merged });
  });

  // 一键测试：按当前偏好发一封测试通知（邮件走 SMTP；桌面通知 FE 侧触发，此处返回 ok 让 FE 弹系统通知）。
  app.post('/api/v1/notifications/test', async (_req, reply) => {
    const prefs = notificationPreference(services);
    const settings = services.settings.load();
    let email: 'sent' | 'skipped' | 'failed' = 'skipped';
    if (settings?.mail.host && settings.mail.enabled) {
      try {
        await services.mailer.send(settings.mail, {
          to: settings.mail.recipients,
          subject: '[直播录制助手] 通知测试',
          text: '这是一封通知测试邮件。',
        });
        email = 'sent';
      } catch {
        email = 'failed';
      }
    }
    return reply.send({ ok: true, desktop: prefs.desktopEnabled, email });
  });

  // 开播预测：只读近 30 天录制事实；样本不足时 predictedWindow=null（FE 显示「暂无预测」）。
  app.get('/api/v1/rooms/:id/live-prediction', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = services.rooms.get(id);
    if (!room) throw new AppError('RESOURCE_NOT_FOUND', '房间不存在', { roomId: id, details: { resource: 'room' } });
    return reply.send(livePrediction(services, id));
  });
}

/** V5 通知偏好校验：返回 AppError 或 null。 */
export function validateNotifications(prefs: NotificationPreference): AppError | null {
  for (const k of ['desktopEnabled', 'liveStarted', 'recordingStarted', 'recordingEnded', 'recordingFailed', 'diskSpaceLow', 'uploadFailed'] as const) {
    if (typeof prefs[k] !== 'boolean') return new AppError('CONFIG_LOAD_FAILED', `${k} 必须为布尔值`);
  }
  if (typeof prefs.dedupeWindowMinutes !== 'number' || prefs.dedupeWindowMinutes < 1 || prefs.dedupeWindowMinutes > 1440) {
    return new AppError('CONFIG_LOAD_FAILED', 'dedupeWindowMinutes 需在 1-1440 之间');
  }
  return null;
}