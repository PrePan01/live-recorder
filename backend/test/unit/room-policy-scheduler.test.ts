import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServices, type Services } from "../../src/core/services.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";

const opened: Services[] = [];
afterEach(async () => {
  for (const services of opened.splice(0)) {
    services.scheduler.stop();
    services.quality.stop();
    await services.manager.shutdown();
    services.db.close();
  }
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
};
function setup() {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ":memory:", clock });
  opened.push(services);
  services.settings.save({
    ...structuredClone(DEFAULT_SETTINGS),
    autoRecord: false,
  });
  const check = vi
    .spyOn(services.adapterFor("bilibili"), "checkLiveStatus")
    .mockResolvedValue({ status: "offline" });
  const create = (id: number, interval: number | null) =>
    services.rooms.create({
      platform: "bilibili",
      url: `https://live.bilibili.com/${id}`,
      displayName: `room${id}`,
      checkIntervalSec: interval,
    });
  const advance = async (ms: number) => {
    clock.advance(ms);
    await settle();
  };
  return { clock, services, check, create, advance };
}
describe("independent polling", () => {
  it("polls rooms at separate deadlines, respects failures, and never catches up missed cycles", async () => {
    const { services, check, create, advance } = setup();
    const fast = create(1, 10);
    const slow = create(2, 30);
    services.scheduler.start();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    check.mockRejectedValue(new Error("offline network"));
    await advance(10_000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(check.mock.calls.at(-1)![0]).toBe(fast.url);
    await advance(10_000);
    expect(check).toHaveBeenCalledTimes(4);
    await advance(10_000);
    expect(check).toHaveBeenCalledTimes(6);
    await advance(300_000);
    expect(check).toHaveBeenCalledTimes(8);
    expect(services.rooms.get(slow.id)).not.toBeNull();
  });
  it("recomputes shortened intervals and enable state, and lets manual checks bypass the deadline", async () => {
    const { services, check, create, advance } = setup();
    const room = create(3, 60);
    services.scheduler.start();
    await settle();
    await advance(20_000);
    expect(check).toHaveBeenCalledTimes(1);
    const updated = services.rooms.update(room.id, { checkIntervalSec: 10 });
    services.events.emit({ type: "room:updated", data: updated });
    await advance(1);
    expect(check).toHaveBeenCalledTimes(2);
    await services.scheduler.triggerImmediateCheck(room.id);
    expect(check).toHaveBeenCalledTimes(3);
    services.events.emit({
      type: "room:updated",
      data: services.rooms.update(room.id, { enabled: false }),
    });
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(3);
    services.events.emit({
      type: "room:updated",
      data: services.rooms.update(room.id, { enabled: true }),
    });
    await advance(1);
    expect(check).toHaveBeenCalledTimes(4);
  });
  it("uses global changes only for inherited rooms and retains bounded platform workers", async () => {
    const { services, check, create, advance } = setup();
    create(4, null);
    const explicit = create(5, 30);
    services.scheduler.start();
    await settle();
    await advance(15_000);
    services.settings.save({
      ...services.settings.load()!,
      checkIntervalSec: { default: 60, bilibili: 10, douyin: 120 },
    });
    services.scheduler.reschedule();
    await advance(1);
    expect(check).toHaveBeenCalledTimes(3);
    expect(check.mock.calls.at(-1)![0]).not.toBe(explicit.url);
  });
});
