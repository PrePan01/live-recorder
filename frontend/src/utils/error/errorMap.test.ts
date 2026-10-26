import { describe, expect, it } from "vitest";
import { describeError } from "./errorMap";

describe("describeError", () => {
  it("后端 message 优先，不被兜底句盖掉更具体的原因", () => {
    expect(
      describeError(
        "PLATFORM_ACCESS_RESTRICTED",
        "小红书访问受限，请在设置中登录或重新授权",
        "xiaohongshu",
      ),
    ).toBe("小红书访问受限，请在设置中登录或重新授权");
  });

  it("受限兜底句带平台名与风控/授权人话", () => {
    expect(describeError("PLATFORM_ACCESS_RESTRICTED", undefined, "xiaohongshu")).toBe(
      "小红书访问受限（可能触发风控或授权失效），请到设置页检查授权",
    );
    expect(describeError("PLATFORM_ACCESS_RESTRICTED", undefined, "douyin")).toContain("抖音");
    expect(describeError("PLATFORM_ACCESS_RESTRICTED", undefined, "bilibili")).toContain("B站");
  });

  it("无平台上下文时兜底句仍提示风控/授权方向", () => {
    expect(describeError("PLATFORM_ACCESS_RESTRICTED", undefined)).toContain("风控");
    expect(describeError("PLATFORM_ACCESS_RESTRICTED", undefined)).toContain("授权");
  });

  it("普通错误码走兜底表，不受平台参数影响", () => {
    expect(describeError("ROOM_LINK_DUPLICATE", undefined, "xiaohongshu")).toBe(
      "该直播间已存在",
    );
    expect(describeError(undefined, undefined)).toBe("操作失败，请稍后重试");
  });
});
