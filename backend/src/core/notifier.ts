import { DEFAULT_NOTIFICATION_PREFERENCE, type MailConfig, type NotificationPreference } from '../types/index.js';
import type { Mailer } from '../mail/mailer.js';
import type { Clock } from './clock.js';
import type { AlertRepository } from '../db/repositories/alert.repo.js';
import { AppEventBus } from './events.js';

export type NotifyEvent = 'live_started' | 'recording_started' | 'recording_ended' | 'recording_failed' | 'disk_space_low' | 'upload_failed';
type PreferenceKey = 'liveStarted' | 'recordingStarted' | 'recordingEnded' | 'recordingFailed' | 'diskSpaceLow' | 'uploadFailed';

const SUBJECTS: Record<NotifyEvent, string> = {
  live_started: '[直播录制助手] 您订阅的 {title} 已开播{recordingSuffix}',
  recording_started: '[直播录制助手] 录制已开始：{title}',
  recording_ended: '[直播录制助手] 录制已结束：{title}',
  recording_failed: '[直播录制助手] 录制失败：{title}',
  disk_space_low: '[直播录制助手] 磁盘空间不足，已暂停新录制',
  upload_failed: '[直播录制助手] 上传失败：{title}',
};
const PREFERENCE_KEY: Record<NotifyEvent, PreferenceKey> = {
  live_started: 'liveStarted', recording_started: 'recordingStarted', recording_ended: 'recordingEnded',
  recording_failed: 'recordingFailed', disk_space_low: 'diskSpaceLow', upload_failed: 'uploadFailed',
};

/** 邮件通知：开播、录制失败和磁盘空间不足；同房间同类事件 30 分钟窗口去重；SMTP 失败只告警不影响录制。 */
export class Notifier {
  private lastSent = new Map<string, number>();
  private pending = 0;
  get busy(): boolean { return this.pending > 0; }
  reset(): void { this.lastSent.clear(); }

  constructor(
    private mailer: Mailer,
    private clock: Clock,
    private alerts: AlertRepository,
    private config: () => MailConfig | null,
    private preferences: () => NotificationPreference = () => DEFAULT_NOTIFICATION_PREFERENCE,
    private events: AppEventBus = new AppEventBus(),
    private windowMs: () => number = () => 30 * 60 * 1000,
  ) {}

  async notify(event: NotifyEvent, roomId: string, context: { title?: string; autoRecordingStarted?: boolean } = {}): Promise<void> {
    const subject = SUBJECTS[event]
      .replace('{title}', context.title ?? '直播')
      .replace('{recordingSuffix}', context.autoRecordingStarted ? '，自动录制已开始' : '');
    const preferenceKey = PREFERENCE_KEY[event];
    const preferences = this.preferences();
    const desktopKey = `desktop:${roomId}:${event}`;
    if (preferences.desktop[preferenceKey] && this.canSend(desktopKey)) {
      this.events.emit({ type: 'desktop:notification', data: { title: 'Live Recorder提醒', body: subject.replace(/^\[直播录制助手\]\s*/, '') } });
      this.lastSent.set(desktopKey, this.clock.now());
    }
    const config = this.config();
    const emailKey = `email:${roomId}:${event}`;
    if (!preferences.email[preferenceKey] || !config || !config.enabled || !config.host || !this.canSend(emailKey)) return;
    this.pending += 1;
    try {
      await this.mailer.send(config, { to: config.recipients, subject, text: subject });
      this.lastSent.set(emailKey, this.clock.now());
    } catch {
      this.alerts.create({ level: 'warning', source: 'smtp', message: `SMTP 通知发送失败（${event}）`, occurredAt: this.clock.iso() });
    } finally {
      this.pending -= 1;
    }
  }

  private canSend(key: string): boolean {
    const last = this.lastSent.get(key);
    if (last !== undefined && this.clock.now() - last < this.windowMs()) return false;
    return true;
  }
}
