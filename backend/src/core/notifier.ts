import type { MailConfig } from '../types/index.js';
import type { Mailer } from '../mail/mailer.js';
import type { Clock } from './clock.js';
import type { AlertRepository } from '../db/repositories/alert.repo.js';

export type NotifyEvent = 'recording_started' | 'recording_failed' | 'disk_space_low';

const SUBJECTS: Record<NotifyEvent, string> = {
  recording_started: '[直播录制助手] 已开播：{title}',
  recording_failed: '[直播录制助手] 录制失败：{title}',
  disk_space_low: '[直播录制助手] 磁盘空间不足，已暂停新录制',
};

/** 邮件通知：三类事件；同房间同类事件 30 分钟窗口去重；SMTP 失败只告警不影响录制。 */
export class Notifier {
  private lastSent = new Map<string, number>();

  constructor(
    private mailer: Mailer,
    private clock: Clock,
    private alerts: AlertRepository,
    private config: () => MailConfig | null,
    private windowMs: () => number = () => 30 * 60 * 1000,
  ) {}

  async notify(event: NotifyEvent, roomId: string, context: { title?: string } = {}): Promise<void> {
    const key = `${roomId}:${event}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && this.clock.now() - last < this.windowMs()) return;

    const config = this.config();
    if (!config || !config.enabled || !config.host) return;
    const subject = SUBJECTS[event].replace('{title}', context.title ?? '直播');
    try {
      await this.mailer.send(config, { to: config.recipients, subject, text: subject });
      this.lastSent.set(key, this.clock.now());
    } catch {
      this.alerts.create({ level: 'warning', source: 'smtp', message: `SMTP 通知发送失败（${event}）`, occurredAt: this.clock.iso() });
    }
  }
}
