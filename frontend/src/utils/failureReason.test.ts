import { describe, expect, it } from "vitest";
import type { ApiErrorEnvelope } from "../types/error";
import { failurePrimaryText } from "./failureReason";

function envelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorEnvelope {
  return {
    code,
    message,
    occurredAt: "2026-01-01T00:00:00.000Z",
    retryable: false,
    details,
  };
}

describe("failurePrimaryText", () => {
  it("后端人话 message 直显", () => {
    expect(
      failurePrimaryText(
        envelope("RECORDING_WRITE_FAILED", "存储设备已断开，录制已停止", {
          technicalMessage: "EIO: i/o error, write",
        }),
      ),
    ).toBe("存储设备已断开，录制已停止");
  });

  it("笼统旧文案换人话兜底，技术原文不上正文", () => {
    const text = failurePrimaryText(
      envelope("RECORDING_START_FAILED", "录制出现异常，已停止（已录内容已保留）", {
        technicalMessage: "录制异常: no such column: gap_count",
      }),
    );
    expect(text).toContain("软件内部数据错误");
    expect(text).not.toContain("no such column");
  });

  it("message 本身就是技术原文时同样换人话兜底", () => {
    expect(
      failurePrimaryText(
        envelope("RECORDING_WRITE_FAILED", "EIO: i/o error, write", {
          technicalMessage: "EIO: i/o error, write",
        }),
      ),
    ).toContain("存储设备读写失败");
  });

  it("老数据无 details 保持原显示", () => {
    expect(
      failurePrimaryText(
        envelope("RECORDING_START_FAILED", "录制因服务重启中断，已保存的内容可能不完整"),
      ),
    ).toBe("录制因服务重启中断，已保存的内容可能不完整");
    expect(failurePrimaryText(null)).toContain("软件内部数据错误");
  });

  it("次数提示只加在磁盘类文案后，网络类文案自身已含恢复语义", () => {
    const disk = failurePrimaryText(
      envelope("RECORDING_WRITE_FAILED", "录制出现异常，已停止", {
        technicalMessage: "EIO",
        attempts: 3,
      }),
    );
    expect(disk).toContain("存储设备读写失败");
    expect(disk).toContain("已自动恢复 3 次仍未成功");
    const net = failurePrimaryText(
      envelope("RECORDING_START_TIMEOUT", "录制出现异常，已停止", {
        technicalMessage: "timeout",
        attempts: 2,
      }),
    );
    expect(net).toBe("网络或平台连接失败，录制已自动尝试恢复");
  });

  it("缺 reasonCategory 时按错误码归组", () => {
    expect(
      failurePrimaryText(
        envelope("RECORDING_FILE_CORRUPTED", "录制出现异常，已停止", {
          technicalMessage: "moov atom not found",
        }),
      ),
    ).toContain("录制文件损坏");
  });
});
