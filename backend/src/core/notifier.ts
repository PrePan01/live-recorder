import type { QmsgQueue } from '../notifications/qmsg.js';
import { DEFAULT_NOTIFICATION_PREFERENCE, type MailConfig, type NotificationPreference } from '../types/index.js';
import type { Mailer } from '../mail/mailer.js';
import type { Clock } from './clock.js';
import type { AlertRepository } from '../db/repositories/alert.repo.js';
import { AppEventBus } from './events.js';

export type NotifyEvent = 'live_started' | 'recording_started' | 'recording_ended' | 'recording_failed' | 'recording_remux_failed' | 'disk_space_low' | 'upload_failed' | 'pipeline_completed' | 'pipeline_failed';
type PreferenceKey = 'liveStarted' | 'recordingStarted' | 'recordingEnded' | 'recordingFailed' | 'diskSpaceLow' | 'uploadFailed' | 'pipelineCompleted' | 'pipelineFailed';

const SUBJECTS: Record<NotifyEvent, string> = {
  pipeline_completed: '[直播录制助手] 后处理完成：{title}',
  pipeline_failed: '[直播录制助手] 后处理失败或部分失败：{title}',
  live_started: '[直播录制助手] 您订阅的 {title} 已开播{recordingSuffix}',
  recording_started: '[直播录制助手] 录制已开始：{title}',
  recording_ended: '[直播录制助手] 录制已结束：{title}',
  recording_failed: '[直播录制助手] 录制失败：{title}',
  recording_remux_failed: '[直播录制助手] 转 MP4 失败，已保留源 FLV：{title}',
  disk_space_low: '[直播录制助手] 磁盘空间不足，请及时清理',
  upload_failed: '[直播录制助手] 上传失败：{title}',
};
// QQ uses a compact plain-text template; transport filtering is confined to this channel.
const QQ_MESSAGES: Record<NotifyEvent, string> = {
  live_started: '开播提醒：{title} 已开播{recordingSuffix}',
  recording_started: '录制开始：{title}',
  recording_ended: '录制结束：{title}',
  recording_failed: '录制失败：{title}，请打开应用查看详情',
  recording_remux_failed: '转 MP4 失败：{title}，源 FLV 已保留',
  disk_space_low: '磁盘空间不足，请及时清理',
  upload_failed: '上传失败：{title}，请打开应用查看详情',
  pipeline_completed: '后处理完成：{title}',
  pipeline_failed: '后处理失败或部分失败：{title}，请打开应用查看详情',
};
const PREFERENCE_KEY: Record<NotifyEvent, PreferenceKey> = {
  pipeline_completed: 'pipelineCompleted', pipeline_failed: 'pipelineFailed',
  live_started: 'liveStarted', recording_started: 'recordingStarted', recording_ended: 'recordingEnded',
  recording_failed: 'recordingFailed', recording_remux_failed: 'recordingFailed', disk_space_low: 'diskSpaceLow', upload_failed: 'uploadFailed',
};

/** 通知项目和渠道由全局偏好决定；开播提醒的房间订阅由调度器判断。 */
export class Notifier {
  private lastSent = new Map<string, number>();
  private pending = 0;
  private stopping = false;
  stop(): void { this.stopping = true; }
  private qqPending = new Set<string>();
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
    private qmsg?: QmsgQueue,
    private qqEnabled: () => boolean = () => false,
    private roomSubscribed: (roomId: string) => boolean = () => true,
  ) {}

  async notify(event: NotifyEvent, roomId: string, context: { title?: string; autoRecordingStarted?: boolean } = {}): Promise<void> {
    if (this.stopping) return;
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
    const qqKey = `qq:${roomId}:${event}`;
    if (this.qmsg && this.qqEnabled() && preferences.qq?.[preferenceKey] && this.canSend(qqKey) && !this.qqPending.has(qqKey)) {
      this.qqPending.add(qqKey);
      const qqText = '[直播录制助手] ' + QQ_MESSAGES[event]
        .replace('{title}', context.title ?? '直播')
        .replace('{recordingSuffix}', context.autoRecordingStarted ? '，自动录制已开始' : '');
      void this.qmsg.enqueue(qqText, () => !this.stopping && this.qqEnabled() && this.preferences().qq[preferenceKey] && (event !== 'live_started' || this.roomSubscribed(roomId)))
        .then(result => { if (result === 'submitted') this.lastSent.set(qqKey, this.clock.now()); })
        .catch(() => {
          if (this.qmsg?.disposed) return;
          const alert = this.alerts.createOrRefresh({ level: 'warning', source: 'qmsg', message: `QQ 通知提交失败（${event}）`, occurredAt: this.clock.iso(), retryable: false });
          this.events.emit({ type: 'alert:created', data: alert });
        })
        .finally(() => this.qqPending.delete(qqKey));
    }
    const config = this.config();
    const emailKey = `email:${roomId}:${event}`;
    if (!preferences.email[preferenceKey] || !config || !config.enabled || !config.host || !this.canSend(emailKey)) return;
    this.pending += 1;
    let timeoutHandle: unknown;
    try {
      // M-1：邮件发送 30 秒硬顶——SMTP 黑洞时 nodemailer 默认超时可达分钟级，
      // 而此 await 在录制收尾关键链（管线/上传入队在通知之后），不得被拖住。
      const sendPromise = this.mailer.send(config, { to: config.recipients, subject, text: subject });
      await Promise.race([
        sendPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = this.clock.setTimeout(() => reject(new Error('SMTP_SEND_TIMEOUT')), 30_000);
        }),
      ]);
      this.lastSent.set(emailKey, this.clock.now());
    } catch {
      this.alerts.create({ level: 'warning', source: 'smtp', message: `SMTP 通知发送失败（${event}）`, occurredAt: this.clock.iso(), retryable: true });
    } finally {
      if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
      this.pending -= 1;
    }
  }

  private canSend(key: string): boolean {
    const last = this.lastSent.get(key);
    if (last !== undefined && this.clock.now() - last < this.windowMs()) return false;
    return true;
  }
}
