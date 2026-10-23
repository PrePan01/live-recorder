import { describe, expect, it } from "vitest";
import {
  BY_ID,
  DEFINITIONS,
  getPath,
  pathPatch,
  searchSettings,
  validateValue,
} from "./catalog";
describe("settings catalog", () => {
  it("小红书设置项与抖音/B站同口径可搜可校验", () => {
    expect(
      searchSettings("cookie", false, () => false).map((d) => d.id),
    ).toEqual(expect.arrayContaining(["xiaohongshu-cookie"]));
    expect(
      searchSettings("小红书", false, () => false).map((d) => d.id),
    ).toEqual(expect.arrayContaining(["xiaohongshu-cookie", "interval-xiaohongshu"]));
    expect(
      searchSettings("检测", true, (id) => id === "interval-xiaohongshu").map(
        (d) => d.id,
      ),
    ).toEqual(["interval-xiaohongshu"]);
    expect(validateValue(BY_ID["interval-xiaohongshu"], 0)).toBeTruthy();
    expect(validateValue(BY_ID["interval-xiaohongshu"], 120)).toBeUndefined();
  });
  it("finds authorization and connection synonyms without reading user input", () => {
    expect(
      searchSettings("cookie", false, () => false).map((d) => d.id),
    ).toEqual(expect.arrayContaining(["douyin-cookie", "bilibili-cookie"]));
    expect(
      searchSettings("SMTP", false, () => false).some(
        (d) => d.id === "email-host",
      ),
    ).toBe(true);
    expect(
      searchSettings("管线", false, () => false).some(
        (d) => d.id === "pipeline-enabled",
      ),
    ).toBe(true);
  });
  it("combines text with modified filtering and never exposes unsafe restoration", () => {
    expect(
      searchSettings("检测", true, (id) => id === "interval-douyin").map(
        (d) => d.id,
      ),
    ).toEqual(["interval-douyin"]);
    expect(
      DEFINITIONS.filter((d) => d.secret || d.id.includes("directory")).every(
        (d) => !d.restorable,
      ),
    ).toBe(true);
    expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length);
  });
  it("accepts disabled compression but rejects partial numeric input", () => {
    expect(validateValue(BY_ID["pipeline-crf"], null)).toBeUndefined();
    expect(validateValue(BY_ID["concurrency"], null)).toBeTruthy();
    expect(validateValue(BY_ID["concurrency"], 1.5)).toBeTruthy();
    expect(validateValue(BY_ID["interval-douyin"], 0)).toBeTruthy();
    expect(validateValue(BY_ID["naming-rule"], "")).toBeTruthy();
  });
  it("validates automatic email edits before enqueueing partial input", () => {
    expect(validateValue(BY_ID["email-port"], null)).toBeTruthy();
    expect(validateValue(BY_ID["email-port"], 465)).toBeUndefined();
    expect(
      validateValue(BY_ID["email-recipients"], "a@example.com,unfinished"),
    ).toBeTruthy();
    expect(
      validateValue(BY_ID["email-recipients"], "a@example.com, b@example.com"),
    ).toBeUndefined();
    expect(validateValue(BY_ID["email-from"], "unfinished")).toBeTruthy();
    expect(validateValue(BY_ID["email-from"], "")).toBeUndefined();
  });
  it("blocks invalid OpenList addresses while allowing HTTP endpoints", () => {
    expect(validateValue(BY_ID["upload-serverUrl"], "https://")).toBeTruthy();
    expect(
      validateValue(BY_ID["upload-serverUrl"], "ftp://example.com"),
    ).toBeTruthy();
    expect(
      validateValue(BY_ID["upload-serverUrl"], "https://example.com/dav"),
    ).toBeUndefined();
  });
  it("writes a nested leaf and reads it back", () => {
    expect(
      getPath(
        pathPatch("checkIntervalSec.douyin", 120),
        "checkIntervalSec.douyin",
      ),
    ).toBe(120);
  });
});
