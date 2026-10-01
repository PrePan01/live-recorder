/**
 * 管线步骤名的人话文案（与 Settings 管线卡、PipelineTimeline 同一口径）。
 * 用户可见面上不出现英文步名（PrePan 口径：compress→压缩、convert→格式转换）。
 */
export const STEP_LABEL: Record<string, string> = {
  verify: '完整性校验',
  sidecar: '信息文件',
  cover: '封面',
  segment: '切片',
  // task #57/#58：管线自动导出音频（segment 后、compress 前）
  audio: '导出音频',
  convert: '格式转换',
  compress: '压缩',
  archive: '归档',
};

/** 步名 → 中文；未知步名原样返回（新步兜底，不误译）。 */
export function pipelineStepText(step?: string | null): string {
  if (!step) return '';
  return STEP_LABEL[step] ?? step;
}
