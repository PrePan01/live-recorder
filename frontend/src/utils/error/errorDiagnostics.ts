// 按应用版本保存本地错误诊断，保留历史累计，并限制重复提醒频率。
const MAX_ENTRIES = 200;
const NOTIFICATION_INTERVAL_MS = 30_000;
const STORAGE_KEY = 'lr-error-diagnostics';

export interface ErrorDiagnostic {
  key: string;
  source: string;
  message: string;
  stack?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  /** legacy 的次数可能跨版本，context 仅代表旧版首次记录，不能精确拆分。 */
  aggregationScope: 'app-version' | 'legacy';
  context: ErrorDiagnosticContext;
}

export interface ErrorDiagnosticContext {
  appVersion: string;
  runtime: string;
  instanceId: string | null;
  recentAction: string | null;
}

export interface ReportedError {
  diagnostic: ErrorDiagnostic;
  shouldNotify: boolean;
}

let entries: ErrorDiagnostic[] = load();
const notifiedAt = new Map<string, number>();
const context: ErrorDiagnosticContext = {
  appVersion: typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown',
  runtime: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent.slice(0, 512),
  instanceId: null,
  recentAction: null,
};

/** Runtime data is local-only; each occurrence captures the latest context. */
export function setErrorDiagnosticContext(next: Partial<Pick<ErrorDiagnosticContext, 'instanceId' | 'appVersion' | 'runtime'>>): void {
  Object.assign(context, next);
}

/** Keep only a coarse operation category; never retain form field values. */
export function recordRecentErrorAction(action: string): void {
  context.recentAction = redact(action).slice(0, 160);
}

function load(): ErrorDiagnostic[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): ErrorDiagnostic[] => {
      if (!item || typeof item !== 'object') return [];
      const input = item as Partial<ErrorDiagnostic>;
      if (typeof input.key !== 'string' || typeof input.source !== 'string' ||
          typeof input.message !== 'string' || !Number.isFinite(input.firstSeenAt) ||
          !Number.isFinite(input.lastSeenAt) || !Number.isFinite(input.count) || input.count! < 1) return [];
      const storedContext = input.context;
      const appVersion = typeof storedContext?.appVersion === 'string' ? storedContext.appVersion : '';
      const aggregationScope = input.aggregationScope === 'app-version' && appVersion ? 'app-version' : 'legacy';
      return [{
        key: aggregationScope === 'app-version' ? diagnosticKey(appVersion, input.source, input.message) : input.key,
        source: input.source,
        message: input.message,
        ...(typeof input.stack === 'string' ? { stack: input.stack } : {}),
        firstSeenAt: input.firstSeenAt!,
        lastSeenAt: input.lastSeenAt!,
        count: input.count!,
        aggregationScope,
        context: {
          appVersion,
          runtime: typeof storedContext?.runtime === 'string' ? storedContext.runtime : 'unknown',
          instanceId: typeof storedContext?.instanceId === 'string' ? storedContext.instanceId : null,
          recentAction: typeof storedContext?.recentAction === 'string' ? storedContext.recentAction : null,
        },
      }];
    }).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function diagnosticKey(appVersion: string, source: string, message: string): string {
  return JSON.stringify([appVersion, source, message]);
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Diagnostics must never make the UI less usable.
  }
}

/** Do not persist URLs containing credentials or common secret-bearing fields. */
function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|password|cookie|authorization)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 2_000);
}

function details(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: redact(reason.message || reason.name), stack: redact(reason.stack ?? '').slice(0, 4_000) || undefined };
  return { message: redact(String(reason)) };
}

/** Expected user cancellation is typed; never hide an arbitrary error by matching text. */
export function isExpectedCancellation(reason: unknown): boolean {
  if (reason instanceof DOMException || reason instanceof Error) return reason.name === 'AbortError' || reason.name === 'CanceledError';
  return typeof reason === 'object' && reason !== null &&
    ((reason as { code?: unknown }).code === 'ERR_CANCELED' || (reason as { name?: unknown }).name === 'AbortError');
}

export function reportError(source: string, reason: unknown): ReportedError {
  const { message, stack } = details(reason);
  // The message is the stable cross-browser stack summary. Full JS stacks contain
  // caller line numbers, which would turn one repeated failure into a storm.
  // Legacy totals cannot be split retrospectively, even if their first version matches.
  const key = diagnosticKey(context.appVersion, source, message);
  const now = Date.now();
  let diagnostic = entries.find((entry) => entry.aggregationScope === 'app-version' && entry.key === key);
  if (diagnostic) {
    diagnostic.lastSeenAt = now;
    diagnostic.count += 1;
    diagnostic.stack = stack;
    diagnostic.context = { ...context };
  } else {
    diagnostic = { key, source, message, stack, firstSeenAt: now, lastSeenAt: now, count: 1, aggregationScope: 'app-version', context: { ...context } };
  }
  entries = [diagnostic, ...entries.filter((entry) => entry !== diagnostic)].slice(0, MAX_ENTRIES);
  const lastNotice = notifiedAt.get(key);
  const shouldNotify = lastNotice === undefined || now - lastNotice >= NOTIFICATION_INTERVAL_MS;
  if (shouldNotify) notifiedAt.set(key, now);
  persist();
  return { diagnostic, shouldNotify };
}

export function recentErrorDiagnostics(): readonly ErrorDiagnostic[] {
  return entries;
}
