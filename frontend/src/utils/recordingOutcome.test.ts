import { describe, expect, it } from "vitest";
import { recordingOutcome } from "./recordingOutcome";
import type { Recording } from "../types/recording";

const recording = (patch: Partial<Recording>) =>
  ({ state: "completed", ...patch }) as Recording;
describe("录制结果摘要", () => {
  it("校验通过且无中断时显示完整录制", () => {
    expect(
      recordingOutcome(
        recording({ integrityState: "ok", gapCount: 0, missingMs: 0 }),
      ),
    ).toBe("完整录制");
  });
  it("校验通过也不能抹掉缺失", () => {
    expect(
      recordingOutcome(
        recording({
          integrityState: "ok",
          gapSummary: { gapCount: 2, totalMissingMs: 18000 },
        }),
      ),
    ).toBe("2 次中断，累计缺失 18 秒");
  });
  it("旧记录无完整性事实和服务重启记录不承诺完整", () => {
    expect(recordingOutcome(recording({ integrityState: "ok" }))).not.toBe(
      "完整录制",
    );
    expect(
      recordingOutcome(
        recording({
          integrityState: "ok",
          endReason: "service_restart",
          gapCount: 0,
          missingMs: 0,
        }),
      ),
    ).not.toBe("完整录制");
  });
  it("进行中不显示结束摘要，文件损坏明确标注", () => {
    expect(recordingOutcome(recording({ state: "recording" }))).toBeNull();
    expect(recordingOutcome(recording({ integrityState: "failed" }))).toBe(
      "文件校验未通过",
    );
  });
});
