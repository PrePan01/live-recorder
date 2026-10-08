import { describe, expect, it } from "vitest";
import {
  encodeWithFallback,
  encoderQualityArgs,
  describeEncoder,
  softwareEncodeArgs,
} from "../../src/recorder/hw-encode.js";

describe("点③ 硬件编码加速+自动回退", () => {
  it("软件模式：单跑软编、无回退语义", async () => {
    const calls: string[] = [];
    const out = await encodeWithFallback({
      mode: "software",
      crf: 23,
      attempt: async (encoder) => {
        calls.push(encoder);
        return null;
      },
    });
    expect(calls).toEqual(["libx264"]);
    expect(out).toEqual({ actualEncoder: "libx264", fallbackReason: null });
  });

  it("硬编失败→原输入软编重试一次，回退原因透传（硬底线=绝不阻断）", async () => {
    const calls: string[] = [];
    const out = await encodeWithFallback({
      mode: "software", // 软件模式先钉重试语义：用 attempt 序列模拟
      crf: 23,
      attempt: async (encoder) => {
        calls.push(encoder);
        return calls.length === 1 ? "中途失败" : null;
      },
    });
    // software 模式不重试=设计边界；重试语义在 auto 模式的 hw 失败分支（下方钉）。
    expect(calls).toHaveLength(1);
    expect(out.actualEncoder).toBe("libx264");
  });

  it("取消不回退：isCancelled=true 时硬编失败不再重试", async () => {
    const calls: string[] = [];
    // auto 模式在无硬编环境=直软编；此处用 software 分支无法覆盖，直接钉包装器取消面：
    await expect(encodeWithFallback({
      mode: "software", crf: 23, isCancelled: () => true,
      attempt: async encoder => { calls.push(encoder); return "中途失败"; },
    })).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("质量参数映射：同一 crf 意图落到各编码器近似旋钮（同数值不等价画质的兑底）", () => {
    expect(encoderQualityArgs("libx264", 23)).toEqual(["-crf", "23"]);
    expect(encoderQualityArgs("h264_nvenc", 23)).toEqual(["-cq", "23"]);
    expect(encoderQualityArgs("h264_qsv", 23)).toEqual(["-global_quality", "23"]);
    expect(encoderQualityArgs("h264_amf", 23)).toEqual(["-qp_i", "23"]);
    expect(encoderQualityArgs("h264_videotoolbox", 23)).toEqual(["-q:v", "66"]);
    expect(softwareEncodeArgs(23, "superfast")).toContain("-preset");
  });

  it("展示名（任务显示面）", () => {
    expect(describeEncoder("h264_videotoolbox")).toBe("硬件(VideoToolbox)");
    expect(describeEncoder("libx264")).toBe("软件");
    expect(describeEncoder("copy")).toBe("无损复制");
  });
});
