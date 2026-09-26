import { AppError, type ErrorCode } from '../types/error.js';

/**
 * 未知状态码统一兜底（状态码分类方案·第一层「兜底不说谎」）。
 * 分桶：HTTP 429/5xx=瞬时繁忙（可重试）、403=权限族（不可重试）、404/405=端点
 * 确实不存在（唯一允许沿用「平台接口有变动」的桶）；body 层未知码与无语义信息一律中性
 * 「未识别状态码 X，已按可重试处理」——任何情况下不得凭空断言接口变动（QA 断言 A5 负例总闸）。
 * 原码与平台提示恒透传 details，供告警/诊断回溯（第三层学习闭环的输入）。
 */
/** 层三·学习闭环：未知码按 scope|码 聚合计数（进程内），供诊断包导出、高频码定期固化。 */
const unknownCounter = new Map<string, { count: number; lastSeen: string; hint: string | null }>();
export function unknownStatusSnapshot(): Array<{ key: string; count: number; lastSeen: string; hint: string | null }> {
  return [...unknownCounter.entries()].map(([key, v]) => ({ key, count: v.count, lastSeen: v.lastSeen, hint: v.hint }));
}
export function resetUnknownStatusCounter(): void {
  unknownCounter.clear();
}

export function unknownStatusFallback(opts: {
  httpStatus?: number | undefined;
  code?: number | undefined;
  hint?: string | undefined;
  scope: string;
}): AppError {
  const { httpStatus, code, hint } = opts;
  const ckey = `${opts.scope}|${code ?? httpStatus ?? "unknown"}`;
  const prev = unknownCounter.get(ckey);
  unknownCounter.set(ckey, { count: (prev?.count ?? 0) + 1, lastSeen: new Date().toISOString(), hint: (hint ?? prev?.hint ?? null)?.slice(0, 160) ?? null });
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

/**
 * 语义族归类（状态码分类方案·第二层）：按「平台提示文本特征优先、码段兜底」把未知码
 * 归入大类（不可见/限流繁忙/鉴权失效）——新码不必认识数值，提示语意不变即自动归对
 * （4003034 靠「可见范围」文本归族的机制化）。文本与码段同时命中时文本优先（QA B5）。
 * 返回 null=两路都不认识，交第一层中性兜底。
 */
export function familyBySemantics(opts: {
  code?: number | undefined;
  hint?: string | undefined;
  scope: string;
}): AppError | null {
  const { code, hint = '', scope } = opts;
  const details: Record<string, unknown> = { scope, matchedBy: 'text' };
  if (code !== undefined) details.code = code;
  if (hint) details.hint = hint.slice(0, 160);
  // ① 文本路（主路）：意图为先，不看数值。
  if (/可见范围|不在主播设置|不在.{0,4}范围|无法进入.{0,6}直播间/.test(hint)) {
    return new AppError(
      'ROOM_CONTENT_UNAVAILABLE',
      '该直播间当前无法查看（如主播设置了可见范围），当前账号不可见',
      { retryable: true, details },
    );
  }
  if (/频繁|限流|rate.?limit|too many|访问过快/i.test(hint)) {
    return new AppError(
      'NETWORK_UNAVAILABLE',
      '平台限流（访问频繁），请稍后重试',
      { retryable: true, details },
    );
  }
  if (/服务繁忙|系统繁忙|busy|service unavailable|服务器(器)?(错误|过载|繁忙)|系统异常|internal server/i.test(hint)) {
    return new AppError(
      'PLATFORM_CHANGED',
      '平台暂时繁忙，请稍后重试',
      { retryable: true, details },
    );
  }
  if (/未登录|请先登录|登录已失效|风控|安全验证|captcha|授权.*(失效|过期|无效)|login required/i.test(hint)) {
    return new AppError(
      'PLATFORM_ACCESS_RESTRICTED',
      '平台访问受限（登录/风控/授权问题），请检查授权状态',
      { retryable: false, details },
    );
  }
  // ② 码段路（兜底，仅在文本无信号时）：4000xxx=业务拒绝多为「内容不可见」类；1xxxx=系统类多为瞬时繁忙。
  if (typeof code === 'number' && code >= 4000000 && code < 5000000) {
    details.matchedBy = 'segment';
    return new AppError(
      'ROOM_CONTENT_UNAVAILABLE',
      `平台拒绝访问该直播间（码 ${code}），当前账号可能无权查看`,
      { retryable: true, details },
    );
  }
  if (typeof code === 'number' && code >= 1000 && code < 2000) {
    details.matchedBy = 'segment';
    return new AppError(
      'PLATFORM_CHANGED',
      `平台内部繁忙（码 ${code}），请稍后重试`,
      { retryable: true, details },
    );
  }
  return null;
}
