import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'lr-error-diagnostics';
let diagnostics: typeof import('./errorDiagnostics');
let storage: Map<string, string>;

async function reload(version = '1.5.3') {
  vi.resetModules();
  diagnostics = await import('./errorDiagnostics');
  diagnostics.setErrorDiagnosticContext({ instanceId: 'instance-1', appVersion: version, runtime: 'runtime-1' });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  await reload();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('error diagnostics', () => {
  it('only treats typed cancellation as expected', () => {
    expect(diagnostics.isExpectedCancellation(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(diagnostics.isExpectedCancellation({ code: 'ERR_CANCELED' })).toBe(true);
    expect(diagnostics.isExpectedCancellation(new Error('The operation was aborted'))).toBe(false);
  });

  it('aggregates repeated errors and redacts credential-bearing URLs', () => {
    diagnostics.recordRecentErrorAction('navigation:/monitor?token=should-not-leak');
    const first = diagnostics.reportError('request', new Error('GET https://alice:secret@example.test/x?token=top-secret failed'));
    const next = diagnostics.reportError('request', new Error('GET https://alice:secret@example.test/x?token=top-secret failed'));
    expect(first.diagnostic.message).not.toContain('secret');
    expect(first.diagnostic.message).not.toContain('top-secret');
    expect(next.diagnostic.count).toBe(2);
    expect(first.shouldNotify).toBe(true);
    expect(next.shouldNotify).toBe(false);
    expect(next.diagnostic.context).toMatchObject({ instanceId: 'instance-1', appVersion: '1.5.3', runtime: 'runtime-1' });
    expect(next.diagnostic.context.recentAction).not.toContain('should-not-leak');
  });

  it('separates versions without resetting the old count or suppressing the new version notice', () => {
    const first = diagnostics.reportError('window.error', 'same failure');
    diagnostics.reportError('window.error', 'same failure');
    diagnostics.setErrorDiagnosticContext({ appVersion: '1.5.4' });
    const updated = diagnostics.reportError('window.error', 'same failure');
    expect(updated.shouldNotify).toBe(true);
    expect(updated.diagnostic.count).toBe(1);
    expect(updated.diagnostic.key).not.toBe(first.diagnostic.key);
    expect(first.diagnostic).toMatchObject({ count: 2, context: { appVersion: '1.5.3' } });
    diagnostics.setErrorDiagnosticContext({ appVersion: '1.5.3' });
    expect(diagnostics.reportError('window.error', 'same failure').diagnostic.count).toBe(3);
    expect(diagnostics.recentErrorDiagnostics()).toHaveLength(2);
  });

  it('keeps the first timestamp and updates the latest stack, context and timestamp', () => {
    const error = new Error('same failure');
    error.stack = 'old stack';
    const firstSeenAt = diagnostics.reportError('window.error', error).diagnostic.firstSeenAt;
    vi.advanceTimersByTime(1000);
    diagnostics.setErrorDiagnosticContext({ instanceId: 'instance-2', runtime: 'runtime-2' });
    diagnostics.recordRecentErrorAction('navigation:/settings?token=secret');
    error.stack = 'new stack https://example.test/?token=secret';
    const result = diagnostics.reportError('window.error', error);
    expect(result.shouldNotify).toBe(false);
    expect(result.diagnostic).toMatchObject({
      count: 2, firstSeenAt, lastSeenAt: firstSeenAt + 1000,
      aggregationScope: 'app-version',
      context: { appVersion: '1.5.3', runtime: 'runtime-2', instanceId: 'instance-2' },
    });
    expect(result.diagnostic.stack).toContain('new stack');
    expect(result.diagnostic.stack).not.toContain('secret');
    expect(result.diagnostic.context.recentAction).toContain('navigation:/settings');
    expect(result.diagnostic.context.recentAction).not.toContain('secret');
    expect(diagnostics.reportError('window.error', 'same failure').diagnostic.stack).toBeUndefined();
  });

  it('retains the thirty-second notice limit independently for each source and version', () => {
    expect(diagnostics.reportError('window.error', 'failure').shouldNotify).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(diagnostics.reportError('window.error', 'failure').shouldNotify).toBe(false);
    expect(diagnostics.reportError('request', 'failure').shouldNotify).toBe(true);
    vi.advanceTimersByTime(1);
    expect(diagnostics.reportError('window.error', 'failure').shouldNotify).toBe(true);
  });

  it('keeps version groups across reloads and updates context after a service restart', async () => {
    diagnostics.reportError('window.error', 'failure');
    await reload('1.5.4');
    diagnostics.reportError('window.error', 'failure');
    await reload('1.5.3');
    diagnostics.setErrorDiagnosticContext({ instanceId: 'instance-restarted' });
    const current = diagnostics.reportError('window.error', 'failure').diagnostic;
    expect(current).toMatchObject({ count: 2, context: { appVersion: '1.5.3', instanceId: 'instance-restarted' } });
    const saved = JSON.parse(storage.get(STORAGE_KEY)!);
    expect(saved).toHaveLength(2);
    expect(saved.every((entry: { aggregationScope: string }) => entry.aggregationScope === 'app-version')).toBe(true);
    expect(saved.find((entry: { context: { appVersion: string } }) => entry.context.appVersion === '1.5.4').count).toBe(1);
  });

  it('preserves ambiguous legacy totals instead of folding them into a matching current version', async () => {
    const legacy = {
      key: 'window.error:failure', source: 'window.error', message: 'failure', stack: 'old stack',
      firstSeenAt: 1000, lastSeenAt: 2000, count: 4756,
      context: { appVersion: '1.5.3', runtime: 'old runtime', instanceId: 'old instance', recentAction: 'navigation:/monitor' },
    };
    storage.set(STORAGE_KEY, JSON.stringify([legacy]));
    await reload();
    expect(diagnostics.recentErrorDiagnostics()).toEqual([{ ...legacy, aggregationScope: 'legacy' }]);
    const current = diagnostics.reportError('window.error', 'failure');
    expect(current.shouldNotify).toBe(true);
    expect(current.diagnostic.count).toBe(1);
    expect(diagnostics.recentErrorDiagnostics()).toHaveLength(2);
    expect(diagnostics.recentErrorDiagnostics()[1]).toEqual({ ...legacy, aggregationScope: 'legacy' });
    await reload();
    expect(diagnostics.reportError('window.error', 'failure').diagnostic.count).toBe(2);
    expect(diagnostics.recentErrorDiagnostics()[1].count).toBe(4756);
  });

  it('retains old records without context and skips malformed items without breaking collection', async () => {
    storage.set(STORAGE_KEY, JSON.stringify([
      null, 'invalid', { key: 'bad' },
      { key: 'old:failure', source: 'old', message: 'failure', count: 3, firstSeenAt: 10, lastSeenAt: 20 },
    ]));
    await reload();
    expect(diagnostics.recentErrorDiagnostics()).toEqual([
      expect.objectContaining({ count: 3, aggregationScope: 'legacy', context: { appVersion: '', runtime: 'unknown', instanceId: null, recentAction: null } }),
    ]);
    expect(diagnostics.reportError('new', 'failure').diagnostic.count).toBe(1);
  });

  it('keeps at most 200 groups and retains a recently recurring group', () => {
    diagnostics.reportError('window.error', 'recurring');
    for (let i = 0; i < 199; i++) diagnostics.reportError('window.error', `failure-${i}`);
    diagnostics.reportError('window.error', 'recurring');
    diagnostics.reportError('window.error', 'newest');
    expect(diagnostics.recentErrorDiagnostics()).toHaveLength(200);
    expect(diagnostics.recentErrorDiagnostics()[1]).toMatchObject({ message: 'recurring', count: 2 });
    expect(diagnostics.recentErrorDiagnostics().some(entry => entry.message === 'failure-0')).toBe(false);
  });

  it.each(['missing', 'unavailable', 'corrupt'])('does not let %s storage break error reporting', async (kind) => {
    if (kind === 'missing') vi.stubGlobal('localStorage', undefined);
    if (kind === 'unavailable') vi.stubGlobal('localStorage', {
      getItem() { throw new Error('access denied'); },
      setItem() { throw new Error('quota exceeded'); },
    });
    if (kind === 'corrupt') storage.set(STORAGE_KEY, '{invalid json');
    await reload();
    const result = diagnostics.reportError('window.error', 'failure');
    expect(result.diagnostic.count).toBe(1);
    expect(result.shouldNotify).toBe(true);
  });
});
