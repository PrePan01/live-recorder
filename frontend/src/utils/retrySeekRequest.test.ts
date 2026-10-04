import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../types/error";
import { retrySeekRequest } from "./retrySeekRequest";

const failure = (retryable: boolean) =>
  new ApiError({
    code: "RECORDING_NOT_AVAILABLE",
    message: "暂未写入",
    retryable,
    occurredAt: "",
  });

afterEach(() => vi.useRealTimers());

describe("回看请求恢复", () => {
  it("索引状态未变化也重试短暂失败，成功后立即停止", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(failure(true))
      .mockResolvedValue({ startSecond: 4 });
    const pending = retrySeekRequest(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ startSecond: 4 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不可重试错误直接结束，可重试错误最多重试三次", async () => {
    vi.useFakeTimers();
    const terminal = vi.fn().mockRejectedValue(failure(false));
    await expect(
      retrySeekRequest(terminal, new AbortController().signal),
    ).rejects.toMatchObject({ retryable: false });
    expect(terminal).toHaveBeenCalledOnce();
    const transient = vi.fn().mockRejectedValue(failure(true));
    const assertion = expect(
      retrySeekRequest(transient, new AbortController().signal),
    ).rejects.toMatchObject({ retryable: true });
    await vi.runAllTimersAsync();
    await assertion;
    expect(transient).toHaveBeenCalledTimes(4);
  });

  it("换位置时立即取消退避计时，不再向旧位置发送请求", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(failure(true));
    const pending = retrySeekRequest(request, controller.signal);
    const assertion = expect(pending).rejects.toThrow("superseded");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("superseded"));
    await assertion;
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("旧请求即使迟到成功也不能提交为新源", async () => {
    const controller = new AbortController();
    let complete!: (value: number) => void;
    const pending = retrySeekRequest(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
      controller.signal,
    );
    const assertion = expect(pending).rejects.toThrow("superseded");
    controller.abort(new Error("superseded"));
    complete(4);
    await assertion;
  });
});
