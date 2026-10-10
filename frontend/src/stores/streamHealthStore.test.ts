import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchActiveRecordingHealth } from "../api/recordings";
import { refreshStreamHealth, useStreamHealthStore } from "./streamHealthStore";
import type { StreamHealth } from "../types/streamHealth";

vi.mock("../api/recordings", () => ({ fetchActiveRecordingHealth: vi.fn() }));
const health = (
  id: string,
  sampledAt: number,
  state: StreamHealth["state"] = "good",
): StreamHealth => ({
  recordingId: id,
  sampledAt,
  state,
  lastDataAt: sampledAt,
  active: true,
});
beforeEach(() => {
  useStreamHealthStore.getState().reset();
  vi.clearAllMocks();
});

describe("健康快照同步", () => {
  it("旧快照不能覆盖更新的 SSE 状态", () => {
    useStreamHealthStore.getState().applyHealth(health("r1", 20, "empty"));
    useStreamHealthStore.getState().applyHealth(health("r1", 10));
    expect(useStreamHealthStore.getState().byRecording.r1.state).toBe("empty");
  });
  it("结束收口删除活动缓存", () => {
    useStreamHealthStore.getState().applyHealth(health("r1", 10));
    useStreamHealthStore
      .getState()
      .applyHealth({ ...health("r1", 20), active: false });
    expect(useStreamHealthStore.getState().byRecording).toEqual({});
  });
  it("多个入口共享在途请求，断线后用批量快照修正旧绿灯", async () => {
    useStreamHealthStore.getState().applyHealth(health("r1", 10));
    vi.mocked(fetchActiveRecordingHealth).mockResolvedValue([
      health("r1", 20, "empty"),
    ]);
    await Promise.all([refreshStreamHealth(), refreshStreamHealth()]);
    expect(fetchActiveRecordingHealth).toHaveBeenCalledTimes(1);
    expect(useStreamHealthStore.getState().byRecording.r1.state).toBe("empty");
  });
  it("快照补齐期间的新 SSE 状态不丢失，清除已结束缓存", async () => {
    useStreamHealthStore.getState().applyHealth(health("ended", 10));
    let resolve!: (data: StreamHealth[]) => void;
    vi.mocked(fetchActiveRecordingHealth).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const request = refreshStreamHealth();
    useStreamHealthStore.getState().applyHealth(health("r1", 30, "empty"));
    resolve([health("r1", 20)]);
    await request;
    expect(useStreamHealthStore.getState().byRecording.ended).toBeUndefined();
    expect(useStreamHealthStore.getState().byRecording.r1.state).toBe("empty");
  });
  it("服务重置后丢弃上一实例的在途响应", async () => {
    let resolve!: (data: StreamHealth[]) => void;
    vi.mocked(fetchActiveRecordingHealth).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const request = refreshStreamHealth();
    useStreamHealthStore.getState().reset();
    resolve([health("old", 10)]);
    await request;
    expect(useStreamHealthStore.getState().byRecording).toEqual({});
  });
  it("在途快照不能复活已结束或删除的录制", async () => {
    let resolve!: (data: StreamHealth[]) => void;
    vi.mocked(fetchActiveRecordingHealth).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const request = refreshStreamHealth();
    useStreamHealthStore.getState().remove("removed");
    useStreamHealthStore
      .getState()
      .applyHealth({ ...health("ended", 20), active: false });
    resolve([health("removed", 10), health("ended", 10)]);
    await request;
    expect(useStreamHealthStore.getState().byRecording).toEqual({});
  });
});
