import { describe, expect, it } from "vitest";
import {
  FIRST_ENABLE_CRF,
  FIRST_ENABLE_SEGMENT_SECONDS,
  buildPipelinePayload,
  derivePipelineSwitches,
} from "./pipelineConfigForm";

/** 改造前 onValuesChange 直发的载荷形状（旧语义）。 */
function legacyPayload(o: {
  enabled: boolean;
  verify: boolean;
  segmentSeconds: number;
  exportAudio?: boolean;
  crf: number | null;
  archiveDirectory: string;
  maxConcurrency: number;
}) {
  return o;
}

describe("derivePipelineSwitches（读取：旧语义反推开关初值）", () => {
  it("0/null/空串 ⇒ 全关", () => {
    expect(
      derivePipelineSwitches({
        segmentSeconds: 0,
        crf: null,
        archiveDirectory: "",
      }),
    ).toEqual({
      segmentEnabled: false,
      crfEnabled: false,
      archiveEnabled: false,
    });
  });
  it("非 0/非 null/非空串 ⇒ 全开", () => {
    expect(
      derivePipelineSwitches({
        segmentSeconds: 30,
        crf: 23,
        archiveDirectory: "/archive",
      }),
    ).toEqual({
      segmentEnabled: true,
      crfEnabled: true,
      archiveEnabled: true,
    });
  });
  it("CRF 0 是合法开启值", () => {
    expect(
      derivePipelineSwitches({
        segmentSeconds: 0,
        crf: 0,
        archiveDirectory: "",
      }).crfEnabled,
    ).toBe(true);
  });
});

describe("buildPipelinePayload（保存：载荷与旧逐字节同构）", () => {
  it("全关配置：键集与取值与旧载荷完全一致", () => {
    const all = {
      enabled: true,
      verify: true,
      segmentSeconds: 0,
      exportAudio: false,
      crf: null,
      archiveDirectory: "",
      maxConcurrency: 2,
      segmentEnabled: false,
      crfEnabled: false,
      archiveEnabled: false,
    };
    const expectPayload = legacyPayload({
      enabled: true,
      verify: true,
      segmentSeconds: 0,
      exportAudio: false,
      crf: null,
      archiveDirectory: "",
      maxConcurrency: 2,
    });
    const payload = buildPipelinePayload(all);
    expect(payload).toEqual(expectPayload);
    expect(Object.keys(payload).sort()).toEqual(
      Object.keys(expectPayload).sort(),
    );
  });

  it("全开配置：值原样透传，开关字段被剥除", () => {
    const payload = buildPipelinePayload({
      enabled: true,
      verify: false,
      segmentSeconds: 45,
      exportAudio: true,
      crf: 30,
      archiveDirectory: "/archive",
      maxConcurrency: 2,
      segmentEnabled: true,
      crfEnabled: true,
      archiveEnabled: true,
    });
    expect(payload).toEqual(
      legacyPayload({
        enabled: true,
        verify: false,
        segmentSeconds: 45,
        exportAudio: true,
        crf: 30,
        archiveDirectory: "/archive",
        maxConcurrency: 2,
      }),
    );
    expect(payload).not.toHaveProperty("segmentEnabled");
    expect(payload).not.toHaveProperty("crfEnabled");
    expect(payload).not.toHaveProperty("archiveEnabled");
  });

  it("首开默认：开关开但值为 0/null ⇒ 10s / CRF 23", () => {
    const payload = buildPipelinePayload({
      enabled: true,
      verify: true,
      segmentSeconds: 0,
      crf: null,
      archiveDirectory: "",
      maxConcurrency: 2,
      segmentEnabled: true,
      crfEnabled: true,
      archiveEnabled: false,
    });
    expect(payload.segmentSeconds).toBe(FIRST_ENABLE_SEGMENT_SECONDS);
    expect(payload.crf).toBe(FIRST_ENABLE_CRF);
    expect(payload.archiveDirectory).toBe("");
  });

  it("CRF 0 开启态不被误判为默认值", () => {
    const payload = buildPipelinePayload({
      enabled: true,
      verify: true,
      segmentSeconds: 0,
      crf: 0,
      archiveDirectory: "",
      maxConcurrency: 2,
      segmentEnabled: false,
      crfEnabled: true,
      archiveEnabled: false,
    });
    expect(payload.crf).toBe(0);
  });

  it("总开关关闭时步骤字段真未挂载 ⇒ 不注入派生键（键集与旧一致）", () => {
    const payload = buildPipelinePayload({
      enabled: false,
      maxConcurrency: 2,
    });
    expect(payload).toEqual({ enabled: false, maxConcurrency: 2 });
    expect(payload).not.toHaveProperty("segmentSeconds");
    expect(payload).not.toHaveProperty("crf");
    expect(payload).not.toHaveProperty("archiveDirectory");
  });
});
