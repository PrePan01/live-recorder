import { describe, expect, it } from 'vitest';
import { isExpectedCancellation, recordRecentErrorAction, reportError, setErrorDiagnosticContext } from './errorDiagnostics';

describe('error diagnostics', () => {
  it('only treats typed cancellation as expected', () => {
    expect(isExpectedCancellation(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(isExpectedCancellation({ code: 'ERR_CANCELED' })).toBe(true);
    expect(isExpectedCancellation(new Error('The operation was aborted'))).toBe(false);
  });

  it('aggregates repeated errors and redacts credential-bearing URLs', () => {
    setErrorDiagnosticContext({ instanceId: 'inst-test', appVersion: '0.5.100-test', runtime: 'test-runtime' });
    recordRecentErrorAction('navigation:/monitor?token=should-not-leak');
    const first = reportError('request', new Error('GET https://alice:secret@example.test/x?token=top-secret failed'));
    const next = reportError('request', new Error('GET https://alice:secret@example.test/x?token=top-secret failed'));
    expect(first.diagnostic.message).not.toContain('secret');
    expect(first.diagnostic.message).not.toContain('top-secret');
    expect(next.diagnostic.count).toBe(2);
    expect(next.shouldNotify).toBe(false);
    expect(first.diagnostic.context).toMatchObject({ instanceId: 'inst-test', appVersion: '0.5.100-test', runtime: 'test-runtime' });
    expect(first.diagnostic.context.recentAction).not.toContain('should-not-leak');
  });
});
