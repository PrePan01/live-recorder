import { describe, expect, it } from "vitest";
import { describeEndReason, isInterruptedEnd } from "./recordingEndReason";

describe("recordingEndReason", () => {
  it("把每种结束原因都翻成中文说法", () => {
    expect(describeEndReason("natural")).toBe("直播结束");
    expect(describeEndReason("stopped")).toBe("手动停止");
    expect(describeEndReason("interrupted")).toBe("中途中断");
    expect(describeEndReason("service_restart")).toBe("重启中断");
  });

  it("进行中的录制与未知取值不显示（不把原始枚举漏给界面）", () => {
    expect(describeEndReason(null)).toBeNull();
    expect(describeEndReason(undefined)).toBeNull();
    expect(describeEndReason("weird" as never)).toBeNull();
  });

  it("中断类结束可被区分出来（内容可能不完整）", () => {
    expect(isInterruptedEnd("interrupted")).toBe(true);
    expect(isInterruptedEnd("service_restart")).toBe(true);
    expect(isInterruptedEnd("natural")).toBe(false);
    expect(isInterruptedEnd("stopped")).toBe(false);
    expect(isInterruptedEnd(null)).toBe(false);
  });
});
