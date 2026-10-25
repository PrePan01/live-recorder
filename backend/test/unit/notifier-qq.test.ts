import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { Notifier, type NotifyEvent } from "../../src/core/notifier.js";
import { buildServices } from "../../src/core/services.js";
import { DEFAULT_NOTIFICATION_PREFERENCE } from "../../src/types/index.js";
import { QmsgQueue } from "../../src/notifications/qmsg.js";
const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function setup() {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ":memory:", clock });
  const preferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCE);
  const send = vi.fn(async () => {});
  const queue = new QmsgQueue(clock, async () => "key", send);
  const notifier = new Notifier(
    services.mailer,
    clock,
    services.alerts,
    () => null,
    () => preferences,
    services.events,
    () => 30 * 60_000,
    queue,
    () => true,
  );
  return { services, clock, preferences, send, queue, notifier };
}
describe("QQ notification delivery", () => {
  it.each<NotifyEvent>([
    "live_started",
    "recording_started",
    "recording_ended",
    "recording_failed",
    "disk_space_low",
    "upload_failed",
    "pipeline_completed",
    "pipeline_failed",
  ])("sends and deduplicates %s even with email disabled", async (event) => {
    const { services, queue, notifier, send } = setup();
    await notifier.notify(event, "room", { title: "主播" });
    await notifier.notify(event, "room", { title: "主播" });
    await settle();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toBeDefined();
    await queue.dispose();
    services.db.close();
  });
  it("filters channel preferences and pending subscriptions before dispatch", async () => {
    const { services, clock, preferences, queue, notifier, send } = setup();
    preferences.qq.uploadFailed = false;
    await notifier.notify("upload_failed", "room");
    await settle();
    expect(send).not.toHaveBeenCalled();
    await queue.enqueue("first");
    let subscribed = true;
    const live = new Notifier(
      services.mailer,
      clock,
      services.alerts,
      () => null,
      () => preferences,
      services.events,
      () => 30 * 60_000,
      queue,
      () => true,
      () => subscribed,
    );
    await live.notify("live_started", "room");
    await settle();
    subscribed = false;
    clock.advance(5000);
    await settle();
    expect(send).toHaveBeenCalledOnce();
    await queue.dispose();
    services.db.close();
  });
  it("continues QQ delivery while SMTP is hung and keeps its failures separate", async () => {
    const { services, clock, preferences, send, queue } = setup();
    const mailer = {
      send: () => new Promise<void>(() => {}),
    } as typeof services.mailer;
    const notifier = new Notifier(
      mailer,
      clock,
      services.alerts,
      () => ({
        enabled: true,
        host: "smtp.test",
        port: 465,
        secure: true,
        username: "u",
        from: "a@test",
        recipients: ["b@test"],
      }),
      () => preferences,
      services.events,
      () => 30 * 60_000,
      queue,
      () => true,
    );
    const email = notifier.notify("recording_failed", "room");
    await settle();
    expect(send).toHaveBeenCalledOnce();
    clock.advance(30_000);
    await email;
    expect(services.alerts.list().map((a) => a.source)).toContain("smtp");
    expect(services.alerts.list().map((a) => a.source)).not.toContain("qmsg");
    await queue.dispose();
    services.db.close();
  });
});
