import { describe, expect, it, vi } from "vitest";
import { OpenListConnection } from "./openListConnection";
import { SettingsSaveQueue } from "./saveQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(test: () => Promise<{ ok: boolean }>) {
  const queue = new SettingsSaveQueue();
  const writeEnabled = vi.fn(async (_enabled: boolean) => {});
  const rejectedEnable = vi.fn();
  const status = vi.fn();
  const connection = new OpenListConnection(queue, { test, writeEnabled, rejectedEnable, status });
  return { queue, connection, writeEnabled, rejectedEnable, status };
}
describe("OpenList connection coordination", () => {
  it("tracks consequential probes for navigation while excluding read-only manual tests", async () => {
    const probe = deferred<{ ok: boolean }>();
    const { queue, connection, writeEnabled } = setup(() => probe.promise);
    const checking = connection.verify("enable");
    expect(connection.hasPendingWrites()).toBe(true);
    const waiting = connection.waitForWrites();
    probe.resolve({ ok: true });
    await checking;
    await waiting;
    await queue.flush();
    expect(connection.hasPendingWrites()).toBe(false);
    expect(writeEnabled).toHaveBeenCalledWith(true);
    await connection.verify("check");
    expect(connection.hasPendingWrites()).toBe(false);
  });
  it("does not occupy the write queue while a network probe is pending", async () => {
    const probe = deferred<{ ok: boolean }>();
    const { queue, connection, writeEnabled } = setup(() => probe.promise);
    const checking = connection.verify("revalidate");
    const save = vi.fn(async () => {});
    queue.enqueue("theme", { theme: "dark" }, save);
    queue.enqueue("quality", { quality: "720p" }, save);
    expect(await queue.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(writeEnabled).not.toHaveBeenCalled();
    probe.resolve({ ok: true });
    expect(await checking).toBe("ok");
  });
  it("enables only after the saved configuration passes verification", async () => {
    const probe = deferred<{ ok: boolean }>();
    const { queue, connection, writeEnabled } = setup(() => probe.promise);
    const checking = connection.verify("enable");
    expect(writeEnabled).not.toHaveBeenCalled();
    probe.resolve({ ok: true });
    await checking;
    await queue.flush();
    expect(writeEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("rejects enabling without ever writing an enabled state on verification failure", async () => {
    const { connection, writeEnabled, rejectedEnable } = setup(async () => { throw new Error("offline"); });
    expect(await connection.verify("enable")).toBe("error");
    expect(writeEnabled).not.toHaveBeenCalled();
    expect(rejectedEnable).toHaveBeenCalledOnce();
  });
  it("ignores an older failed probe after credentials change", async () => {
    const probe = deferred<{ ok: boolean }>();
    const { queue, connection, writeEnabled, status } = setup(() => probe.promise);
    const checking = connection.verify("revalidate");
    connection.invalidate();
    probe.reject(new Error("old credentials"));
    expect(await checking).toBe("stale");
    await queue.flush();
    expect(writeEnabled).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
  });
  it("rechecks the configuration version when an enable write reaches the queue", async () => {
    const gate = deferred<void>();
    const { queue, connection, writeEnabled } = setup(async () => ({ ok: true }));
    queue.enqueue("theme", {}, () => gate.promise);
    await connection.verify("enable");
    connection.invalidate();
    gate.resolve();
    await queue.flush();
    expect(writeEnabled).not.toHaveBeenCalled();
  });
  it("queues disabling on current verification failure and retains failed writes for retry", async () => {
    const { queue, connection, writeEnabled, status } = setup(async () => { throw new Error("offline"); });
    writeEnabled.mockRejectedValueOnce(new Error("write failed"));
    await connection.verify("revalidate");
    expect(await queue.flush()).toBe(false);
    expect(queue.getSnapshot()["upload-enabled"].phase).toBe("error");
    queue.retry("upload-enabled");
    expect(await queue.flush()).toBe(true);
    expect(writeEnabled).toHaveBeenLastCalledWith(false);
    expect(status).toHaveBeenLastCalledWith({ phase: "error", message: "连接检测未通过，已关闭自动上传：offline" });
  });
  it("cancels enabling if the user changes configuration while writes are flushing", async () => {
    const gate = deferred<boolean>();
    const test = vi.fn(async () => ({ ok: true }));
    const { connection, writeEnabled } = setup(test);
    const checking = connection.verify("enable", () => gate.promise);
    connection.invalidate();
    gate.resolve(true);
    expect(await checking).toBe("stale");
    expect(test).not.toHaveBeenCalled();
    expect(writeEnabled).not.toHaveBeenCalled();
  });
});
