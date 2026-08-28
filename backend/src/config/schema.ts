import { AppError } from '../types/error.js';
import type { AppSettings } from '../types/settings.js';

/** 配置校验（阶段 B 手写检查；阶段 B-E4 路由层补 JSON Schema）。 */
export function validateSettings(input: unknown): AppSettings {
  if (typeof input !== 'object' || input === null) {
    throw new AppError('CONFIG_LOAD_FAILED', '配置格式非法');
  }
  const s = input as Partial<AppSettings>;
  if (typeof s.recordingDirectory !== 'string' || s.recordingDirectory.length === 0) {
    throw new AppError('DIRECTORY_NOT_WRITABLE', '录像目录未配置');
  }
  if (typeof s.maxConcurrentRecordings !== 'number' || s.maxConcurrentRecordings < 1 || s.maxConcurrentRecordings > 8) {
    throw new AppError('CONFIG_LOAD_FAILED', '最大并发数需在 1-8 之间');
  }
  if (s.recordingFormat !== undefined && s.recordingFormat !== 'source_flv' && s.recordingFormat !== 'mp4_after') {
    throw new AppError('CONFIG_LOAD_FAILED', '录制格式仅支持 source_flv / mp4_after');
  }
  const ci = s.checkIntervalSec;
  if (!ci || typeof ci.default !== 'number' || ci.default < 10 || typeof ci.bilibili !== 'number' || ci.bilibili < 10 || typeof ci.douyin !== 'number' || ci.douyin < 10) {
    throw new AppError('CONFIG_LOAD_FAILED', 'checkIntervalSec 需包含 default/bilibili/douyin 且不小于 10 秒');
  }
  const r = s.retry;
  if (!r || !Array.isArray(r.delaysSeconds) || r.delaysSeconds.length === 0 || typeof r.maxAttempts !== 'number' || r.maxAttempts < 0) {
    throw new AppError('CONFIG_LOAD_FAILED', '重连配置非法');
  }
  const d = s.diskGuard;
  if (!d || typeof d.minFreeBytes !== 'number' || d.minFreeBytes < 0 || typeof d.minFreePercent !== 'number' || d.minFreePercent < 0 || d.minFreePercent > 90) {
    throw new AppError('CONFIG_LOAD_FAILED', '磁盘保护配置非法');
  }
  const m = s.mail;
  if (m && (typeof m.host !== 'string' || typeof m.port !== 'number' || !Array.isArray(m.recipients))) {
    throw new AppError('CONFIG_LOAD_FAILED', '邮件配置非法');
  }
  return s as AppSettings;
}
