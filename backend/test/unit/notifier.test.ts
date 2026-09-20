import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { Notifier } from '../../src/core/notifier.js';
import { buildServices, type Services } from '../../src/core/services.js';
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
});
