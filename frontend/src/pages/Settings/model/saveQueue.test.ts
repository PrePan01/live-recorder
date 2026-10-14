import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSaveQueue, mergePatch, acknowledgeDrafts } from "./saveQueue";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe("settings save coordinator", () => {
  it("flushes only the requested configuration without unrelated validation blocking it", async () => {
    vi.useFakeTimers();
    const queue = new SettingsSaveQueue();
    const email = vi.fn(async () => {});
    const theme = vi.fn(async () => {});
    queue.stage("interval-default", "invalid");
    queue.stage("cookie-manual");
    queue.enqueue("theme", { theme: "dark" }, theme, 500);
    queue.enqueue("email-host", { host: "smtp.example.com" }, email, 500);
    expect(await queue.flush(["email-host"])).toBe(true);
    expect(email).toHaveBeenCalledOnce();
    expect(theme).not.toHaveBeenCalled();
    expect(await queue.flush()).toBe(false);
    queue.stage("email-host", "invalid host");
    expect(await queue.flush(["email-host"])).toBe(false);
  });
  it("serializes writes across endpoints and coalesces edits waiting behind a request", async () => {
    const queue = new SettingsSaveQueue();
    const gate = deferred();
    const seen: unknown[] = [];
    queue.enqueue("mail", { host: "smtp" }, async (patch) => {
      seen.push(patch);
      await gate.promise;
    });
    queue.enqueue("frequency", { interval: { douyin: 20 } }, async (patch) => {
      seen.push(patch);
    });
    queue.enqueue(
      "frequency",
      { interval: { douyin: 60, bilibili: 90 } },
      async (patch) => {
        seen.push(patch);
      },
    );
    expect(seen).toEqual([{ host: "smtp" }]);
    gate.resolve();
    expect(await queue.flush()).toBe(true);
    expect(seen).toEqual([
      { host: "smtp" },
      { interval: { douyin: 60, bilibili: 90 } },
    ]);
  });
  it("retains failed edits and pauses only that group until explicit retry", async () => {
    const queue = new SettingsSaveQueue();
    let fail = true;
    const seen: unknown[] = [];
    const save = async (patch: unknown) => {
      if (fail) throw new Error("offline");
      seen.push(patch);
    };
    queue.enqueue("quality", { value: "720p" }, save);
    expect(await queue.flush()).toBe(false);
    queue.enqueue("quality", { value: "1080p" }, save);
    queue.enqueue("theme", { value: "dark" }, async (patch) => {
      seen.push(patch);
    });
    await queue.flush();
    expect(seen).toEqual([{ value: "dark" }]);
    fail = false;
    queue.retry("quality");
    expect(await queue.flush()).toBe(true);
    expect(seen).toEqual([{ value: "dark" }, { value: "1080p" }]);
  });
  it("flushes debounced edits before navigation without waiting for the timer", async () => {
    vi.useFakeTimers();
    const queue = new SettingsSaveQueue();
    const save = vi.fn(async () => {});
    queue.enqueue("size", { value: 40 }, save, 500);
    queue.enqueue("size", { value: 48 }, save, 500);
    expect(save).not.toHaveBeenCalled();
    expect(queue.hasUnsaved()).toBe(true);
    expect(await queue.flush()).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith({ value: 48 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("does not allow an invalid or unsubmitted form to be silently left", async () => {
    const queue = new SettingsSaveQueue();
    queue.stage("mail");
    queue.stage("concurrency", "invalid");
    expect(await queue.flush()).toBe(false);
    queue.discard("mail");
    queue.discard("concurrency");
    expect(await queue.flush()).toBe(true);
  });
  it("keeps a newer draft status when an older request finishes", async () => {
    const queue = new SettingsSaveQueue();
    const gate = deferred();
    queue.enqueue("mail", { host: "first" }, () => gate.promise);
    queue.stage("mail");
    gate.resolve();
    expect(await queue.flush()).toBe(false);
    expect(queue.getSnapshot().mail.phase).toBe("draft");
  });
  it("a discarded debounced patch cannot overwrite imported configuration", async () => {
    vi.useFakeTimers();
    const queue = new SettingsSaveQueue();
    const save = vi.fn(async () => {});
    queue.enqueue("size", { value: 40 }, save, 500);
    queue.discard("size");
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
  it("does not resurrect a discarded failed request or overwrite a newer invalid draft", async () => {
    const queue = new SettingsSaveQueue();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, r) => {
      reject = r;
    });
    queue.enqueue("concurrency", { value: 3 }, () => pending);
    queue.stage("concurrency", "invalid number");
    reject(new Error("offline"));
    await queue.flush();
    expect(queue.getSnapshot().concurrency.phase).toBe("invalid");
    queue.discard("concurrency");
    expect(await queue.flush()).toBe(true);
  });
  it("acknowledges sent values while preserving edits made during API or event refresh", () => {
    expect(
      acknowledgeDrafts(
        { host: "newer", port: 465, password: "new secret" },
        { host: "old", port: 465 },
      ),
    ).toEqual({ host: "newer", password: "new secret" });
  });
  it("merges nested leaves without replacing unrelated values", () => {
    expect(
      mergePatch({ desktop: { a: true, b: false } }, { desktop: { a: false } }),
    ).toEqual({ desktop: { a: false, b: false } });
  });
});
