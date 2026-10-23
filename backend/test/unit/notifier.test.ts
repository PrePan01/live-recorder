import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { Notifier, type NotifyEvent } from '../../src/core/notifier.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import { DEFAULT_NOTIFICATION_PREFERENCE, type MailConfig } from '../../src/types/index.js';

const MAIL: MailConfig = { enabled: true, host: 'smtp.x.com', port: 465, secure: true, username: 'u', from: 'f', recipients: ['a@b.c'] };

function newServices(): { services: Services; clock: FakeClock } {
  const clock = new FakeClock();
  return { services: buildServices({ dbPath: ':memory:', clock }), clock };
}

describe('Notifier', () => {
  it('sends one mail per event/room and dedupes within the 30min window', async () => {
    const { services, clock } = newServices();
    const notifier = new Notifier(services.mailer, clock, services.alerts, () => MAIL, () => DEFAULT_NOTIFICATION_PREFERENCE, services.events);
    const mailer = services.mailer as FakeMailer;

    await notifier.notify('live_started', 'room1', { title: '主播A' });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain('您订阅的 主播A 已开播');

    await notifier.notify('live_started', 'room1', { title: '主播A' });
    expect(mailer.sent).toHaveLength(1);

    await notifier.notify('live_started', 'room2', { title: '主播B', autoRecordingStarted: true });
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toContain('自动录制已开始');

    await notifier.notify('recording_failed', 'room1', { title: '主播A' });
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[2]!.subject).toContain('录制失败');

    // 转封装失败复用“录制失败”通知开关，不能只留在应用内告警中心。
    await notifier.notify('recording_remux_failed', 'room1', { title: '主播A' });
    expect(mailer.sent).toHaveLength(4);
    expect(mailer.sent[3]!.subject).toContain('转 MP4 失败');

    await notifier.notify('disk_space_low', 'room1');
    expect(mailer.sent).toHaveLength(5);
    expect(mailer.sent[4]!.subject).toContain('磁盘空间不足');

    clock.advance(31 * 60 * 1000);
    await notifier.notify('live_started', 'room1', { title: '主播A' });
    expect(mailer.sent).toHaveLength(6);
  });

  it('skips when mail is disabled and only alerts on SMTP failure', async () => {
    const { services, clock } = newServices();
    const mailer = services.mailer as FakeMailer;
    const disabled = new Notifier(services.mailer, clock, services.alerts, () => ({ ...MAIL, enabled: false }), () => DEFAULT_NOTIFICATION_PREFERENCE, services.events);
    await disabled.notify('live_started', 'room1');
    expect(mailer.sent).toHaveLength(0);

    const enabled = new Notifier(services.mailer, clock, services.alerts, () => MAIL, () => DEFAULT_NOTIFICATION_PREFERENCE, services.events);
    mailer.failNext = true;
    await enabled.notify('disk_space_low', 'room1');
    expect(mailer.sent).toHaveLength(0);
    const alerts = services.alerts.list();
    expect(alerts.some((a) => a.source === 'smtp' && a.message.includes('SMTP 通知发送失败'))).toBe(true);
  });

  it.each<NotifyEvent>(['recording_started', 'recording_ended', 'recording_failed', 'recording_remux_failed', 'disk_space_low', 'upload_failed'])('uses global channels for %s regardless of room reminder and legacy channel switches', async (event) => {
    const { services } = newServices();
    const preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCE);
    for (const key of Object.keys(preferences.desktop) as Array<keyof typeof preferences.desktop>) {
      preferences.desktop[key] = true;
      preferences.email[key] = true;
    }
    services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), mail: MAIL, notifications: preferences });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/800', displayName: '通知测试' });
    const mailer = services.mailer as FakeMailer;
    const notices: string[] = [];
    services.events.on(e => { if (e.type === 'desktop:notification') notices.push(e.data.body); });
    for (const channels of [{ desktop: false, email: false }, { desktop: true, email: false }, { desktop: false, email: true }, { desktop: true, email: true }]) {
      services.notifier.reset();
      mailer.sent.length = 0;
      notices.length = 0;
      services.rooms.update(room.id, { liveNotificationEnabled: channels.desktop, liveEmailNotificationEnabled: channels.email });
      await services.notifier.notify(event, room.id);
      await services.notifier.notify(event, room.id);
      expect(notices).toHaveLength(1);
      expect(mailer.sent).toHaveLength(1);
    }
    services.db.close();
  });

  it('uses current global event preferences and mail configuration even when room reminders are disabled', async () => {
    const { services } = newServices();
    const preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCE);
    preferences.desktop.recordingStarted = false;
    preferences.email.recordingStarted = true;
    preferences.desktop.recordingEnded = true;
    preferences.email.recordingEnded = false;
    services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), mail: MAIL, notifications: preferences });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/801', displayName: '通知项目', liveNotificationEnabled: false, liveEmailNotificationEnabled: false });
    const mailer = services.mailer as FakeMailer;
    const notices: string[] = [];
    services.events.on(e => { if (e.type === 'desktop:notification') notices.push(e.data.body); });
    await services.notifier.notify('recording_started', room.id);
    await services.notifier.notify('recording_ended', room.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('录制已结束');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain('录制已开始');
    services.settings.save({ ...services.settings.load()!, mail: { ...MAIL, enabled: false } });
    await services.notifier.notify('recording_failed', room.id);
    expect(mailer.sent).toHaveLength(1);
    services.db.close();
  });

  it('邮件发送 30 秒硬顶：SMTP 挂起不再拖住录制收尾关键链（M-1）', async () => {
    const { services, clock } = newServices();
    const hanging = { send: () => new Promise<never>(() => {}) } as unknown as typeof services.mailer;
    const notifier = new Notifier(hanging, clock, services.alerts, () => MAIL, () => DEFAULT_NOTIFICATION_PREFERENCE, services.events);
    const pending = notifier.notify('recording_failed', 'room1', { title: '主播A' });
    clock.advance(30_000);
    // 超时后 notify 必须落定（告警不抛），收尾链不被黑洞 SMTP 拖住。
    await pending;
    const listed = services.alerts.list({ limit: 50 });
    expect(listed.some((a) => a.message.includes('SMTP'))).toBe(true);
  });
});
