import { describe, expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { unknownStatusFallback, unknownStatusSnapshot, resetUnknownStatusCounter } from '../../src/platform/status-fallback.js';

describe('告警载荷 retryable（迁移39）', () => {
  it('创建/刷新/列表全链携带可重试语义', () => {
    const services = buildServices({ dbPath: ':memory:' });
    const a = services.alerts.create({ level: 'error', source: 'platform', message: 'm1', occurredAt: '2026-09-25T00:00:00Z', roomId: 'r1', errorCode: 'X', retryable: false });
    expect(a.retryable).toBe(false);
    expect(services.alerts.get(a.id)!.retryable).toBe(false);
    expect(services.alerts.list({}).find((x) => x.id === a.id)!.retryable).toBe(false);
    // 去重刷新携带最新语义（COALESCE：新值为空保留旧值）
    const b = services.alerts.createOrRefresh({ level: 'error', source: 'platform', message: 'm1', occurredAt: '2026-09-25T00:01:00Z', roomId: 'r1', errorCode: 'X', retryable: true });
    expect(b.id).toBe(a.id);
    expect(services.alerts.get(a.id)!.retryable).toBe(true);
    // 未提供时保留旧值、新告警为 null
    const c = services.alerts.create({ level: 'info', source: 's', message: 'm2', occurredAt: '2026-09-25T00:00:00Z' });
    expect(c.retryable).toBeNull();
  });
});

describe('层三·未知码聚合计数', () => {
  it('中性兜底必计数，快照带 key/count/hint，可重置', () => {
    resetUnknownStatusCounter();
    unknownStatusFallback({ code: 888001, hint: '怪', scope: 't' });
    unknownStatusFallback({ code: 888001, hint: '怪', scope: 't' });
    unknownStatusFallback({ httpStatus: 502, scope: 't' });
    const snap = unknownStatusSnapshot();
    expect(snap.find((x) => x.key === 't|888001')!.count).toBe(2);
    expect(snap.find((x) => x.key === 't|888001')!.hint).toBe('怪');
    expect(snap.find((x) => x.key === 't|502')!.count).toBe(1);
    resetUnknownStatusCounter();
    expect(unknownStatusSnapshot()).toHaveLength(0);
  });
});
