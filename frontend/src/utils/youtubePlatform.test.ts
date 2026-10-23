import { describe, it, expect } from "vitest";
import { guessPlatform, PLATFORM_LABEL } from "./roomPlatform";

describe("YouTube platform presentation", () => {
  it.each([
    "https://youtube.com/@creator",
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk",
    "https://youtube.com/@bilibili.com",
    "https://www.youtube.com/watch?v=abcdefghijk&ref=douyin.com",
  ])("detects %s", (url) => expect(guessPlatform(url)).toBe("youtube"));
  it("does not accept another site with YouTube in the path or hostname", () => {
    expect(
      guessPlatform("https://youtube.com.evil.test/watch?v=abcdefghijk"),
    ).toBeNull();
    expect(
      guessPlatform("https://example.com/youtube.com/@creator"),
    ).toBeNull();
  });
  it("keeps existing platform detection and labels", () => {
    expect(guessPlatform("https://live.bilibili.com/1")).toBe("bilibili");
    expect(guessPlatform("https://live.douyin.com/1")).toBe("douyin");
    expect(PLATFORM_LABEL.youtube).toBe("YouTube");
  });
});
