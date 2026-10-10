import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  QualityHealthService,
  type HealthProbe,
  type StreamHealth,
} from "../../src/core/quality-health.js";
import { RecorderManager } from "../../src/core/recorder-manager.js";

const running: QualityHealthService[] = [];
afterEach(() => {
  for (const svc of running.splice(0)) svc.stop();
  delete process.env.LR_QA_FORCE_STATE;
  delete process.env.LR_QA_SILENCE_AFTER_S;
});

function setup(mediaTsMs: number | null = 0) {
  const clock = new FakeClock();
  let probe: HealthProbe = {
    recordingId: "r1",
    roomId: "room1",
    bytes: 1000,
    mediaTsMs,
    lastDataAt: clock.now(),
    writeError: false,
    qualityFallback: false,
  };
  let active = true;
  const events: StreamHealth[] = [];
  const service = new QualityHealthService({
    clock,
    manager: { healthProbe: () => (active ? [probe] : []) },
    events: {
      emit: (e: { type: string; data: StreamHealth }) => {
        if (e.type === "stream-health") events.push(e.data);
      },
    },
  } as unknown as ConstructorParameters<typeof QualityHealthService>[0]);
  running.push(service);
  const advance = (
    ticks: number,
    data = true,
    deltaBytes = 300_000,
    deltaMedia = 3000,
  ) => {
    for (let i = 0; i < ticks; i++) {
      if (data)
        probe = {
          ...probe,
          bytes: probe.bytes + deltaBytes,
          mediaTsMs:
            probe.mediaTsMs == null ? null : probe.mediaTsMs + deltaMedia,
          lastDataAt: clock.now() + 3000,
        };
      clock.advance(3000);
    }
  };
  return {
    clock,
    service,
    events,
    advance,
    patch: (p: Partial<HealthProbe>) => {
      probe = { ...probe, ...p };
    },
    finish: () => {
      active = false;
      clock.advance(3000);
    },
  };
}

describe("录制健康状态", () => {
  it("正常 HLS 缺少媒体时钟仍保持正常", () => {
    const f = setup(null);
    f.advance(30);
    expect(f.service.snapshot("r1").state).toBe("good");
    expect(f.service.snapshot("r1").issue).toBeNull();
  });
  it("长分片 HLS 等待下一段时不报静默或码率跌落，真正停流仍会告警", () => {
    const f = setup(null);
    f.patch({ dataIntervalMs: 30000 });
    f.advance(3);
    for (let i = 0; i < 3; i++) {
      f.advance(9, false);
      expect(f.service.snapshot("r1").state).toBe("good");
      f.advance(1, true, 3_000_000);
    }
    f.advance(22, false);
    expect(f.service.snapshot("r1").state).toBe("degraded");
    f.advance(10, false);
    expect(f.service.snapshot("r1").state).toBe("empty");
  });
  it("首包未到时不报正常", () => {
    const f = setup(null);
    f.patch({ bytes: 0 });
    f.advance(1, false);
    expect(f.service.snapshot("r1").state).toBe("unknown");
    expect(f.service.snapshot("r1").lastDataAt).toBeNull();
  });
  it("静默推进经过降级、无数据，恢复后返回正常", () => {
    const f = setup();
    f.advance(3);
    f.advance(4, false);
    expect(f.service.snapshot("r1").state).toBe("degraded");
    f.advance(8, false);
    expect(f.service.snapshot("r1").state).toBe("empty");
    f.advance(3);
    expect(f.service.snapshot("r1").state).toBe("good");
  });
  it("短暂数据抖动不报降级", () => {
    const f = setup();
    f.advance(3);
    f.advance(2, false);
    f.advance(2);
    expect(f.service.snapshot("r1").state).toBe("good");
    expect(f.events.some((e) => e.state === "degraded")).toBe(false);
  });
  it("当前写入错误恢复后解除红灯", () => {
    const f = setup();
    f.advance(3);
    f.patch({ writeError: true });
    f.advance(2);
    expect(f.service.snapshot("r1").issue).toBe("write_error");
    f.patch({ writeError: false, missingMs: 8000 });
    f.advance(2);
    expect(f.service.snapshot("r1")).toMatchObject({
      state: "good",
      issue: null,
      missingMs: 8000,
    });
  });
  it("探针不把历史重试次数当作当前写入错误", () => {
    const probe = RecorderManager.prototype.healthProbe.call({
      active: new Map([
        [
          "room1",
          {
            recordingId: "r1",
            size: 1000,
            lastDataAt: 1000,
            writeRestartCount: 1,
            writeRestartPending: false,
            gapStartAt: null,
            missingMs: 0,
          },
        ],
      ]),
      previewSessions: new Map(),
      services: { recordings: { get: () => null } },
    } as unknown as RecorderManager);
    expect(probe[0]).toMatchObject({ writeError: false, mediaTsMs: null });
  });
  it("同一降级状态中原因变化也会更新", () => {
    const f = setup();
    f.advance(15);
    f.advance(7, true, 300_000, 0);
    expect(f.service.snapshot("r1").issue).toBe("media_stalled");
    f.advance(2, false);
    expect(f.service.snapshot("r1")).toMatchObject({
      state: "degraded",
      issue: "no_data",
      reason: "直播数据暂时中断",
    });
  });
  it("建立基线后持续码率下降才告警", () => {
    const f = setup();
    f.advance(12);
    f.advance(2, true, 10_000);
    expect(f.service.snapshot("r1").state).toBe("good");
    f.advance(5, true, 10_000);
    expect(f.service.snapshot("r1")).toMatchObject({
      state: "degraded",
      issue: "low_bitrate",
    });
  });
  it("稳定状态定期同步最近数据，而不是每采样刷事件", () => {
    const f = setup();
    f.advance(3);
    const count = f.events.length;
    f.advance(10);
    expect(f.events.length - count).toBe(2);
    expect(f.events.at(-1)!.lastDataAt).toBeGreaterThan(
      f.events[count - 1].lastDataAt!,
    );
  });
  it("结束后收口并释放历史快照", () => {
    const f = setup();
    f.advance(3);
    f.finish();
    expect(f.service.snapshotAll()).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({ recordingId: "r1", active: false });
    expect(f.service.snapshot("r1").state).toBe("unknown");
  });
  it("停止服务取消后续定时采样", () => {
    const f = setup();
    f.advance(3);
    f.service.stop();
    const count = f.events.length;
    f.advance(10);
    expect(f.events.length).toBe(count);
    expect(f.clock.pendingTimers()).toBe(0);
  });
  it("清晰度回退和恢复过程独立于健康灯透传", () => {
    const f = setup(null);
    f.patch({ qualityFallback: true, recovering: true, missingMs: 3000 });
    f.advance(3);
    expect(f.service.snapshot("r1")).toMatchObject({
      state: "good",
      qualityFallback: true,
      recovering: true,
      missingMs: 3000,
    });
  });
  it("环境测试钩子仍支持定态及静默注入", () => {
    process.env.LR_QA_FORCE_STATE = "degraded:测试注入";
    const f = setup();
    f.advance(3);
    expect(f.service.snapshot("r1")).toMatchObject({
      state: "degraded",
      reason: "测试注入",
    });
    delete process.env.LR_QA_FORCE_STATE;
    process.env.LR_QA_SILENCE_AFTER_S = "1";
    f.advance(15);
    expect(f.service.snapshot("r1").state).toBe("empty");
  });
});
