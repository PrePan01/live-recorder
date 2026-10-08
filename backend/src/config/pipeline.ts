import { AppError } from '../types/error.js';
import { DEFAULT_PIPELINE_CONFIG, type PipelineConfig } from '../types/settings.js';

/** V5 管线配置校验：返回 AppError 或 null。 */
export function validatePipelineConfig(input: unknown): AppError | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return new AppError('PIPELINE_CONFIG_INVALID', 'pipeline 必须为对象');
  const config = { ...DEFAULT_PIPELINE_CONFIG, ...input } as PipelineConfig;
  if (typeof config.enabled !== 'boolean') return new AppError('PIPELINE_CONFIG_INVALID', 'enabled 必须为布尔值');
  if (typeof config.verify !== 'boolean') return new AppError('PIPELINE_CONFIG_INVALID', 'verify 必须为布尔值');
  if (!Number.isFinite(config.segmentSeconds) || config.segmentSeconds < 0 || config.segmentSeconds > 86400) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'segmentSeconds 需在 0-86400 之间');
  }
  if (config.crf !== null && (!Number.isFinite(config.crf) || config.crf < 0 || config.crf > 51)) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'crf 需为 null 或 0-51 之间');
  }
  if (typeof config.archiveDirectory !== 'string') return new AppError('PIPELINE_CONFIG_INVALID', 'archiveDirectory 必须为字符串');
  if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 2) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'maxConcurrency 需为 1-2（V5 定 N=2）');
  }
  if (config.exportAudio !== undefined && typeof config.exportAudio !== 'boolean') {
    return new AppError('PIPELINE_CONFIG_INVALID', 'exportAudio 必须为布尔值');
  }
  if (config.exportCover !== undefined && typeof config.exportCover !== 'boolean') {
    return new AppError('PIPELINE_CONFIG_INVALID', 'exportCover 必须为布尔值');
  }
  if (config.outputFormat !== undefined && config.outputFormat !== 'source' && config.outputFormat !== 'mp4') {
    return new AppError('PIPELINE_CONFIG_INVALID', 'outputFormat 必须为 source 或 mp4');
  }
  if (config.deleteSourceAfterConvert !== undefined && typeof config.deleteSourceAfterConvert !== 'boolean') {
    return new AppError('PIPELINE_CONFIG_INVALID', 'deleteSourceAfterConvert 必须为布尔值');
  }
  return null;
}

