import { describe, expect, it } from "vitest";
import type { RecordingGap } from "../types/recording";
import { recordingGapText } from "./recordingGapText";

const gap = (patch: Partial<RecordingGap> = {}): RecordingGap => ({
  id: "gap-1",
  startedAt: "2026-10-06T00:00:00Z",
  endedAt: "2026-10-06T00:00:31Z",
  missingMs: 31_000,
  kind: "stream_disconnect",
  evidence: null,
  ...patch,
});

describe("recordingGapText", () => {
  it("labels confirmed system sleep in plain language", () => {
    expect(recordingGapText(gap({ kind: "system_sleep" })))
      .toEqual({ status: "系统唤醒", reason: "系统休眠，录制中断" });
  });
  it("explains old interruption evidence without exposing timestamps or byte counts", () => {
    expect(recordingGapText(gap({ evidence: '{"gapStartAt":1791212916294,"size":221505261}' })))
      .toEqual({ status: "恢复录制", reason: "直播数据传输中断，具体原因未记录。" });
  });

  it.each([
    ["NETWORK_UNAVAILABLE", "网络或直播平台连接异常"],
    ["RECORDING_WRITE_FAILED", "录像保存失败"],
    ["STREAM_URL_EXPIRED", "直播地址已失效"],
    ["PLATFORM_SERVER_ERROR", "直播平台服务异常"],
    ["RECORDING_START_TIMEOUT", "等待直播数据超时"],
  ])("translates %s and does not reuse its technical message", (code, text) => {
    const result = recordingGapText(gap({
      evidence: JSON.stringify({ cause: { code, message: "ECONNRESET: internal debug data" } }),
    }));
    expect(result.status).toBe("恢复录制");
    expect(result.reason).toContain(text);
    expect(result.reason).not.toContain(code);
    expect(result.reason).not.toContain("ECONNRESET");
    expect(result.reason).not.toContain("已停止");
  });

  it("distinguishes an unrecovered silent tail from resumed recording", () => {
    expect(recordingGapText(gap({ kind: "recording_tail" })))
      .toEqual({ status: "录制结束", reason: "录制结束前持续未收到直播数据，这段时间未录入录像。" });
    expect(recordingGapText(gap({ kind: "service_restart" })).reason).toContain("录制服务重启");
  });

  it.each([null, "invalid JSON", "null", "[]", '{"cause":null}', '{"cause":{"code":"FUTURE_ERROR","message":"raw diagnostic"}}', '{"cause":{"code":"toString"}}'])
    ("handles missing, invalid and unknown evidence: %s", (evidence) => {
      expect(recordingGapText(gap({ kind: "future_kind", evidence })))
        .toEqual({ status: "中断记录", reason: "直播数据传输中断，具体原因未记录。" });
    });
});
