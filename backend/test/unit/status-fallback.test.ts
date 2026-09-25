import { describe, expect, it } from 'vitest';
import { familyBySemantics, unknownStatusFallback } from '../../src/platform/status-fallback.js';
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


  it('第二层语义族：文本路优先归族（可见范围/限流/繁忙/鉴权四族）', () => {
    const vis = familyBySemantics({ code: 4009999, hint: '你不在主播设置的可见范围内', scope: 't' })!;
    expect(vis.code).toBe('ROOM_CONTENT_UNAVAILABLE');
    expect(vis.message).toContain('可见范围');
    expect(vis.retryable).toBe(true);
    const limit = familyBySemantics({ code: 777, hint: '操作过于频繁，请稍后重试', scope: 't' })!;
    expect(limit.code).toBe('NETWORK_UNAVAILABLE');
    expect(limit.retryable).toBe(true);
    const busy = familyBySemantics({ code: 778, hint: 'Service Unavailable', scope: 't' })!;
    expect(busy.message).toContain('繁忙');
    expect(busy.retryable).toBe(true);
    const auth = familyBySemantics({ code: 779, hint: '登录已失效，请重新登录', scope: 't' })!;
    expect(auth.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(auth.retryable).toBe(false);
    // 两路都不认识 → null（交第一层中性兜底）
    expect(familyBySemantics({ code: 42, hint: 'something odd', scope: 't' })).toBeNull();
  });

  it('第二层码段兜底 + 文本优先（B5：文本与码段同时命中按文本归族）', () => {
    const segBiz = familyBySemantics({ code: 4001234, hint: '', scope: 't' })!;
    expect(segBiz.code).toBe('ROOM_CONTENT_UNAVAILABLE');
    expect(segBiz.details?.matchedBy).toBe('segment');
    const segSys = familyBySemantics({ code: 1500, hint: '', scope: 't' })!;
    expect(segSys.message).toContain('繁忙');
    expect(segSys.retryable).toBe(true);
    // 4000xxx 码段=业务拒绝，但文本说是限流 → 文本赢
    const textWins = familyBySemantics({ code: 4005555, hint: '请求过于频繁', scope: 't' })!;
    expect(textWins.code).toBe('NETWORK_UNAVAILABLE');
    expect(textWins.details?.matchedBy).toBe('text');
  });
});
