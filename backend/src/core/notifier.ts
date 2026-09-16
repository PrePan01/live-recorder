import type { MailConfig } from '../types/index.js';
import type { Mailer } from '../mail/mailer.js';
import type { Clock } from './clock.js';
import type { AlertRepository } from '../db/repositories/alert.repo.js';

export type NotifyEvent = 'live_started' | 'recording_failed' | 'disk_space_low';

const SUBJECTS: Record<NotifyEvent, string> = {
  live_started: '[直播录制助手] 您订阅的 {title} 已开播{recordingSuffix}',
  recording_failed: '[直播录制助手] 录制失败：{title}',
  disk_space_low: '[直播录制助手] 磁盘空间不足，已暂停新录制',
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
    private windowMs: () => number = () => 30 * 60 * 1000,
  ) {}

  async notify(event: NotifyEvent, roomId: string, context: { title?: string; autoRecordingStarted?: boolean } = {}): Promise<void> {
    const key = `${roomId}:${event}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && this.clock.now() - last < this.windowMs()) return;

    const config = this.config();
    if (!config || !config.enabled || !config.host) return;
    const subject = SUBJECTS[event]
      .replace('{title}', context.title ?? '直播')
      .replace('{recordingSuffix}', context.autoRecordingStarted ? '，自动录制已开始' : '');
    this.pending += 1;
    try {
      await this.mailer.send(config, { to: config.recipients, subject, text: subject });
      this.lastSent.set(key, this.clock.now());
    } catch {
      this.alerts.create({ level: 'warning', source: 'smtp', message: `SMTP 通知发送失败（${event}）`, occurredAt: this.clock.iso() });
    } finally {
      this.pending -= 1;
    }
  }
}
