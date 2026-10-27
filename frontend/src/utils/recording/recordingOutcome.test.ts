import { describe, expect, it } from "vitest";
import { recordingIntegrityLabel, recordingOutcome } from "./recordingOutcome";
import type { Recording } from "../../types/recording";

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
  it("旧记录校验通过且无中断数据时视作完整，明确重启中断仍保留提示", () => {
    expect(recordingOutcome(recording({ integrityState: "ok" }))).toBe(
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

describe("历史录制完整性标签兼容", () => {
  it.each([
    "pending",
    "queued",
    "verifying",
    "unverifiable",
    "failed",
  ] as const)("%s 保留专用状态标签，不被未知覆盖", (integrityState) => {
    expect(recordingIntegrityLabel(recording({ integrityState }))).toBeNull();
    expect(
      recordingIntegrityLabel(recording({ integrityState, missingMs: 18000 })),
    ).toBeNull();
  });
  it.each<[string, Partial<Recording>, string | null]>([
    [
      "旧字段通过且明确无缺失",
      { integrity: "verified", gapCount: 0, missingMs: 0 },
      "完整",
    ],
    [
      "新字段通过且明确无缺失",
      { integrityState: "ok", gapCount: 0, missingMs: 0 },
      "完整",
    ],
    ["旧通过记录缺少中断事实", { integrity: "verified" }, "完整"],
    ["旧记录完全没有校验字段", {}, "未知"],
    [
      "旧记录仅有缺失时长",
      { integrity: "verified", missingMs: 18000 },
      "已校验，有中断",
    ],
    [
      "旧记录仅有中断次数",
      { integrity: "verified", gapCount: 2 },
      "已校验，有中断",
    ],
    ["旧未校验记录有缺失", { missingMs: 18000 }, "未知"],
    ["旧失败记录有缺失", { integrity: "failed", missingMs: 18000 }, null],
    ["新失败记录有缺失", { integrityState: "failed", missingMs: 18000 }, null],
    [
      "新状态优先于旧通过值",
      { integrityState: "pending", integrity: "verified", missingMs: 18000 },
      null,
    ],
    [
      "新通过值优先于旧失败值",
      { integrityState: "ok", integrity: "failed", gapCount: 0, missingMs: 0 },
      "完整",
    ],
    [
      "重启记录不承诺完整",
      {
        integrity: "verified",
        endReason: "service_restart",
        gapCount: 0,
        missingMs: 0,
      },
      "未知",
    ],
    [
      "接口补出的零值按无中断兼容",
      {
        integrity: "verified",
        gapSummary: { gapCount: 0, totalMissingMs: 0, estimated: true },
      },
      "完整",
    ],
    [
      "估算中断仍有详细提示",
      {
        integrity: "verified",
        gapSummary: { gapCount: 2, totalMissingMs: 18000, estimated: true },
      },
      "已校验，有中断",
    ],
    ["正在录制保留原标签", { state: "recording" }, null],
  ])("%s", (_name, patch, label) => {
    expect(recordingIntegrityLabel(recording(patch))).toBe(label);
  });

  it("历史估算零值显示完整，Popover 仍保留实际缺失详情", () => {
    expect(
      recordingOutcome(
        recording({
          integrity: "verified",
          gapSummary: { gapCount: 0, totalMissingMs: 0, estimated: true },
        }),
      ),
    ).toBe("完整录制");
    expect(
      recordingOutcome(recording({ integrity: "verified", missingMs: 18000 })),
    ).toBe("累计缺失 18 秒");
    expect(
      recordingOutcome(
        recording({
          integrity: "verified",
          gapSummary: { gapCount: 2, totalMissingMs: 18000, estimated: true },
        }),
      ),
    ).toBe("2 次中断，约 累计缺失 18 秒");
  });
});
