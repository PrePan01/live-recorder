import { describe, expect, it } from "vitest";
import { diskDisplay, isDirectoryUnavailable } from "./diskDisplay";

describe("isDirectoryUnavailable", () => {
  it("treats only explicit false as unavailable", () => {
    expect(isDirectoryUnavailable(false)).toBe(true);
    expect(isDirectoryUnavailable(true)).toBe(false);
    expect(isDirectoryUnavailable(undefined)).toBe(false);
  });
});

describe("diskDisplay", () => {
  it("shows 磁盘可用 with progress when space is healthy", () => {
    expect(diskDisplay(true, 100e9, 1e12)).toEqual({
      text: "磁盘可用",
      danger: false,
      spaceDanger: false,
      showProgress: true,
      showCleanup: false,
    });
  });

  it("shows 磁盘空间不足 with progress and cleanup tag when low", () => {
    expect(diskDisplay(true, 5e9, 1e12)).toEqual({
      text: "⚠ 磁盘空间不足",
      danger: true,
      spaceDanger: true,
      showProgress: true,
      showCleanup: true,
    });
  });

  it("low ratio below 10% also counts as low even with large absolute free", () => {
    const d = diskDisplay(true, 50e9, 1e12);
    expect(d.spaceDanger).toBe(true);
    expect(d.showCleanup).toBe(true);
  });

  it("directory unavailable wins over low space: red text, no progress/cleanup", () => {
    expect(diskDisplay(false, 5e9, 1e12)).toEqual({
      text: "磁盘不可用",
      danger: true,
      spaceDanger: false,
      showProgress: false,
      showCleanup: false,
    });
  });

  it("keeps legacy behavior when backend has no directoryAvailable field", () => {
    expect(diskDisplay(undefined, 5e9, 1e12).text).toContain("磁盘空间不足");
    expect(diskDisplay(undefined, 100e9, 1e12).text).toBe("磁盘可用");
  });

  it("treats zero/absent total as ratio 0 (low space when free is also low)", () => {
    const d = diskDisplay(undefined, 0, 0);
    expect(d.spaceDanger).toBe(true);
  });
});
