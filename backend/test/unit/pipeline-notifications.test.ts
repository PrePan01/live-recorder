import { describe, expect, it, vi } from "vitest";
import { buildServices } from "../../src/core/services.js";
import type { PipelineRunStatus } from "../../src/types/index.js";
function setup() {
  const services = buildServices({ dbPath: ":memory:" });
  const room = services.rooms.create({
    platform: "bilibili",
    url: "https://live.bilibili.com/1",
    displayName: "主播",
  });
  const recording = services.recordings.create({
    roomId: room.id,
    roomName: room.displayName,
    platform: "bilibili",
    streamSessionId: "session",
    streamTitle: "直播",
  });
  const notify = vi.spyOn(services.notifier, "notify").mockResolvedValue();
  vi.spyOn(services.uploader, "enqueue").mockResolvedValue({
    queued: false,
  } as never);
  const create = () =>
    services.pipeline.repo.createRun({
      recordingId: recording.id,
      configSnapshot: {},
    });
  const finish = (id: string, status: PipelineRunStatus) =>
    (
      services.pipeline as unknown as {
        finish: (id: string, status: PipelineRunStatus) => void;
      }
    ).finish(id, status);
  return { services, notify, recording, create, finish };
}
describe("pipeline terminal notifications", () => {
  it.each(["ok", "partial", "failed"] as const)(
    "emits %s once per run and notifies again for a retry run",
    async (status) => {
      const { services, notify, create, finish } = setup();
      const run = create();
      finish(run.id, status);
      finish(run.id, status);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0]).toBe(
        status === "ok" ? "pipeline_completed" : "pipeline_failed",
      );
      const retry = create();
      finish(retry.id, status);
      expect(notify).toHaveBeenCalledTimes(2);
      services.db.close();
    },
  );
  it.each(["任务已取消", "录制已删除", "应用关闭"])(
    "does not alert for deliberate cancellation: %s",
    (reason) => {
      const { services, notify, recording, create } = setup();
      create();
      services.pipeline.cancel(recording.id, reason);
      expect(notify).not.toHaveBeenCalled();
      services.db.close();
    },
  );
  it("reports watchdog failures and ignores new sends during shutdown", async () => {
    const { services, notify, recording, create } = setup();
    create();
    services.pipeline.cancel(recording.id, "心跳超时强制收割");
    expect(notify).toHaveBeenCalledOnce();
    notify.mockRestore();
    const emit = vi.spyOn(services.events, "emit");
    services.notifier.stop();
    await services.notifier.notify("recording_failed", recording.roomId);
    expect(emit).not.toHaveBeenCalled();
    services.db.close();
  });
});
