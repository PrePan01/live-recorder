import { describe, expect, it, vi, afterEach } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { QmsgQueue, qmsgText, sendQmsg } from "../../src/notifications/qmsg.js";
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => vi.unstubAllGlobals());

describe("Qmsg sender and queue", () => {
  it("uses the official POST endpoint, filters content and checks business success", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: 42 })),
      );
    vi.stubGlobal("fetch", fetcher);
    await sendQmsg(
      "secret-key",
      "主播 https://example.com/123 127.0.0.1 123456 开播了",
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://qmsg.zendee.cn/v3/send/secret-key",
    );
    const request = fetcher.mock.calls[0][1];
    expect(request.method).toBe("POST");
    expect(request.body.get("msg")).not.toMatch(/https:|127|123456/);
    expect(Array.from(qmsgText("中".repeat(2000)))).toHaveLength(1800);
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ success: false, message: "secret-key" })),
    );
    await expect(
      sendQmsg("secret-key", "测试", new AbortController().signal),
    ).rejects.toThrow("QQ 推送提交失败");
    fetcher.mockRejectedValue(
      new Error("https://qmsg.zendee.cn/v3/send/secret-key"),
    );
    await expect(
      sendQmsg("secret-key", "测试", new AbortController().signal),
    ).rejects.not.toThrow("secret-key");
  });

  it("serializes events and tests at least five seconds apart for the same key", async () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const queue = new QmsgQueue(
      clock,
      async () => "key",
      async () => {
        times.push(clock.now());
      },
    );
    const first = queue.enqueue("事件");
    const second = queue.enqueue("测试");
    await settle();
    expect(times).toHaveLength(1);
    clock.advance(4999);
    await settle();
    expect(times).toHaveLength(1);
    clock.advance(1);
    await settle();
    await expect(first).resolves.toBe("submitted");
    await expect(second).resolves.toBe("submitted");
    expect(times[1]! - times[0]!).toBe(5000);
    await queue.dispose();
  });

  it("rechecks preferences and credentials after waiting and invalidates pending jobs", async () => {
    const clock = new FakeClock();
    const send = vi.fn(async () => {});
    let key: string | null = "old";
    let enabled = true;
    const queue = new QmsgQueue(clock, async () => key, send);
    await queue.enqueue("first");
    const disabled = queue.enqueue("disabled", () => enabled);
    await settle();
    enabled = false;
    clock.advance(5000);
    await settle();
    await expect(disabled).resolves.toBe("skipped");
    await queue.enqueue("filler");
    const changed = queue.enqueue("changed");
    await settle();
    key = "new";
    queue.invalidate();
    await expect(changed).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(2);
    await queue.dispose();
  });

  it("bounds requests, reports overflow, times out and never retries uncertain sends", async () => {
    const clock = new FakeClock();
    const send = vi.fn(() => new Promise<void>(() => {}));
    const warning = vi.fn();
    const queue = new QmsgQueue(clock, async () => "key", send, warning);
    const first = queue.enqueue("hanging");
    const failure = expect(first).rejects.toThrow("QQ 推送提交失败");
    const pending = Array.from({ length: 99 }, () =>
      queue.enqueue("pending").catch(() => "closed"),
    );
    await expect(queue.enqueue("overflow")).rejects.toThrow("队列已满");
    expect(warning).toHaveBeenCalledOnce();
    await settle();
    clock.advance(10_000);
    await settle();
    await failure;
    queue.invalidate();
    await queue.dispose();
    await Promise.all(pending);
    expect(send).toHaveBeenCalledTimes(2); // next queued job starts, no retry of the first
    await queue.dispose();
    expect(queue.busy).toBe(false);
  });

  it("aborts hanging senders during shutdown even if the sender ignores the signal", async () => {
    const clock = new FakeClock();
    const queue = new QmsgQueue(
      clock,
      async () => "key",
      () => new Promise<void>(() => {}),
    );
    const result = queue.enqueue("hanging").catch(() => "closed");
    await settle();
    await queue.dispose();
    expect(await result).toBe("closed");
    expect(queue.busy).toBe(false);
  });
});
