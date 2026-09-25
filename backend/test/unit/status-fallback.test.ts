import { describe, expect, it } from 'vitest';
import { unknownStatusFallback } from '../../src/platform/status-fallback.js';
import { DouyinAdapter } from '../../src/platform/douyin.js';

describe('状态码第一层：兜底不说谎', () => {
  it('A5 负例总闸：任意未知输入永不输出「接口有变动」（仅 404/405）', () => {
    const unknowns = [
      { code: 999999 },
      { httpStatus: 503 },
      { httpStatus: 429 },
      { httpStatus: 403 },
      { httpStatus: 400 },
      { httpStatus: 418 },
      {},
      { code: 12345, hint: '怪提示' },
    ];
    for (const c of unknowns) {
      const err = unknownStatusFallback({ ...c, scope: 'test' });
      expect(err.message, JSON.stringify(c)).not.toContain('接口有变动');
    }
    for (const st of [404, 405]) {
      expect(unknownStatusFallback({ httpStatus: st, scope: 'test' }).message).toContain('接口有变动');
    }
  });

  it('分桶真值表：5xx/429=繁忙可重试、403=权限不可重试、未知=中性可重试，原码透传 details', () => {
    const busy = unknownStatusFallback({ httpStatus: 503, code: 503, scope: 't' });
    expect(busy.message).toContain('繁忙');
    expect(busy.retryable).toBe(true);
    const limited = unknownStatusFallback({ httpStatus: 429, scope: 't' });
    expect(limited.message).toContain('繁忙');
    expect(limited.retryable).toBe(true);
    const forbidden = unknownStatusFallback({ httpStatus: 403, scope: 't' });
    expect(forbidden.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(forbidden.retryable).toBe(false);
    const unknown = unknownStatusFallback({ code: 777777, hint: 'h', scope: 't' });
    expect(unknown.message).toContain('未识别状态码 777777');
    expect(unknown.retryable).toBe(true);
    expect(unknown.details?.code).toBe(777777);
    expect(unknown.details?.hint).toBe('h');
    expect(unknown.details?.scope).toBe('t');
    const gone = unknownStatusFallback({ httpStatus: 404, scope: 't' });
    expect(gone.retryable).toBe(false);
  });

});
