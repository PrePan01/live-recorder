import { AppError, type ErrorCode } from '../types/error.js';

/**
 * 未知状态码统一兜底（状态码分类方案·第一层「兜底不说谎」）。
 * 分桶：HTTP 429/5xx=瞬时繁忙（可重试）、403=权限族（不可重试）、404/405=端点
 * 确实不存在（唯一允许沿用「平台接口有变动」的桶）；body 层未知码与无语义信息一律中性
 * 「未识别状态码 X，已按可重试处理」——任何情况下不得凭空断言接口变动（QA 断言 A5 负例总闸）。
 * 原码与平台提示恒透传 details，供告警/诊断回溯（第三层学习闭环的输入）。
 */
export function unknownStatusFallback(opts: {
  httpStatus?: number | undefined;
  code?: number | undefined;
  hint?: string | undefined;
  scope: string;
}): AppError {
  const { httpStatus, code, hint } = opts;
  const details: Record<string, unknown> = { scope: opts.scope };
  if (httpStatus !== undefined) details.httpStatus = httpStatus;
  if (code !== undefined) details.code = code;
  if (hint) details.hint = hint;
  const shown = code ?? httpStatus;
  if (httpStatus !== undefined) {
    if (httpStatus === 429 || httpStatus >= 500) {
      return new AppError('PLATFORM_CHANGED', `平台暂时繁忙（码 ${shown}），请稍后重试`, { retryable: true, details });
    }
    if (httpStatus === 403) {
      return new AppError('PLATFORM_ACCESS_RESTRICTED', `平台访问受限（码 ${shown}），请检查授权`, { retryable: false, details });
    }
    if (httpStatus === 404 || httpStatus === 405) {
      return new AppError('PLATFORM_CHANGED', '平台接口有变动，请稍后重试', { retryable: false, details });
    }
  }
  return new AppError(
    'PLATFORM_CHANGED',
    `平台返回了未识别状态码 ${shown}，已按可重试处理；持续出现请反馈诊断包`,
    { retryable: true, details },
  );
}
