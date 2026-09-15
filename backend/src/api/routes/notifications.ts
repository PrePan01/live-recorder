import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import { DEFAULT_NOTIFICATION_PREFERENCE, type NotificationPreference } from '../../types/index.js';
import type { AppSettings } from '../../types/index.js';
import { calculateLivePrediction, recordingFallbackEvents, type LivePrediction } from '../../core/live-prediction.js';

export type { LivePrediction, PredictionConfidence } from '../../core/live-prediction.js';

/** V5 通知偏好读写（GET/PUT /settings/notifications，随 settings 存储）。 */
export function notificationPreference(services: Services): NotificationPreference {
  const settings = services.settings.load() as AppSettings | null;
  const stored = settings?.notifications;
  return { ...DEFAULT_NOTIFICATION_PREFERENCE, ...(stored ?? {}) };
}

/**
 * 检测观测优先；旧录像低权重补充未被检测记录覆盖的日期。
 */
export function livePrediction(services: Services, roomId: string): LivePrediction {
  const from = new Date(services.clock.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const events = services.liveEvents.list(roomId, from);
  const recordings = services.recordings.list({ roomId, pageSize: 100, dateFrom: from }).items;
  return calculateLivePrediction({
    roomId, events,
    fallbackEvents: recordingFallbackEvents(recordings),
    now: services.clock.now(), generatedAt: services.clock.iso(),
    calibration: services.predictionCalibration.profiles([roomId], localDateFromMs(services.clock.now() - 60 * 24 * 60 * 60 * 1000)).get(roomId),
    coverage: services.predictionCalibration.intervals([roomId], from).get(roomId),
  });
}

function localDateFromMs(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

  // 开播预测使用近 60 天观测；没有观测历史时才低权重回退到旧录像开始时间。
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
    if (typeof prefs[k] !== 'boolean') return new AppError('CONFIG_INVALID', `${k} 必须为布尔值`);
  }
  if (typeof prefs.dedupeWindowMinutes !== 'number' || prefs.dedupeWindowMinutes < 1 || prefs.dedupeWindowMinutes > 1440) {
    return new AppError('CONFIG_INVALID', 'dedupeWindowMinutes 需在 1-1440 之间');
  }
  return null;
}
