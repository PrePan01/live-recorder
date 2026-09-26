import type { PipelineConfig } from "../../../types/pipeline";

/**
 * 设置页「后处理管线」步骤化表单的纯映射层（task #65）。
 * 约定：UI 用三个独立布尔开关表达切片/压缩/归档的开与关，
 * 保存载荷仍为旧语义——关 ⇒ segmentSeconds=0 / crf=null / archiveDirectory=''，
 * 与改造前逐字节同构（接口契约不变、旧配置零迁移、后端零改动）。
 */

export interface PipelineSwitchValues {
  segmentEnabled?: boolean;
  crfEnabled?: boolean;
  archiveEnabled?: boolean;
}

/** 读取：按旧语义（0/null/空串=关）反推三个开关的初值。 */
export function derivePipelineSwitches(
  config: Pick<PipelineConfig, "segmentSeconds" | "crf" | "archiveDirectory">,
): Required<PipelineSwitchValues> {
  return {
    segmentEnabled: config.segmentSeconds > 0,
    crfEnabled: config.crf != null,
    archiveEnabled: config.archiveDirectory !== "",
  };
}

/** 首开默认值：切片 10s、压缩 CRF 23（评估稿 dda73910 定死）。 */
export const FIRST_ENABLE_SEGMENT_SECONDS = 10;
export const FIRST_ENABLE_CRF = 23;

type FormValues = Record<string, unknown>;

/**
 * 保存：剥掉三个 UI 开关字段，按开关状态派生旧语义三字段，
 * 其余字段原样透传——输出键集与取值与改造前 onValuesChange 直发的载荷一致。
 */
export function buildPipelinePayload(all: FormValues): Partial<PipelineConfig> {
  const { segmentEnabled, crfEnabled, archiveEnabled, ...rest } = all;
  const has = (k: string) =>
    Object.prototype.hasOwnProperty.call(rest, k) && rest[k] !== undefined;
  const out: Record<string, unknown> = { ...rest };

  // segmentSeconds：开 ⇒ 现值（>0）否则首开默认 10s；关 ⇒ 0（字段未挂载则不注入，键集与旧一致）
  if (segmentEnabled === true) {
    out.segmentSeconds =
      has("segmentSeconds") && Number(rest.segmentSeconds) > 0
        ? Number(rest.segmentSeconds)
        : FIRST_ENABLE_SEGMENT_SECONDS;
  } else if (has("segmentSeconds")) {
    out.segmentSeconds = 0;
  }

  // crf：开 ⇒ 现值否则首开默认 23；关 ⇒ null
  if (crfEnabled === true) {
    out.crf =
      has("crf") && rest.crf != null && rest.crf !== ""
        ? Number(rest.crf)
        : FIRST_ENABLE_CRF;
  } else if (has("crf")) {
    out.crf = null;
  }

  // archiveDirectory：开 ⇒ 现路径（UI 已拦截空路径）；关 ⇒ ''
  if (archiveEnabled === true) {
    out.archiveDirectory = String(rest.archiveDirectory ?? "");
  } else if (has("archiveDirectory")) {
    out.archiveDirectory = "";
  }

  return out as Partial<PipelineConfig>;
}
