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
  appVersion: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.5.100',
  runtime: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent.slice(0, 512),
  instanceId: null,
  recentAction: null,
};

/** Runtime data is local-only and captured with new diagnostic groups. */
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
    return Array.isArray(value) ? value.slice(0, MAX_ENTRIES) as ErrorDiagnostic[] : [];
  } catch {
    return [];
  }
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
  const key = `${source}:${message}`;
  const now = Date.now();
  let diagnostic = entries.find((entry) => entry.key === key);
  if (diagnostic) {
    diagnostic.lastSeenAt = now;
    diagnostic.count += 1;
  } else {
    diagnostic = { key, source, message, stack, firstSeenAt: now, lastSeenAt: now, count: 1, context: { ...context } };
    entries = [diagnostic, ...entries].slice(0, MAX_ENTRIES);
  }
  const lastNotice = notifiedAt.get(key) ?? 0;
  const shouldNotify = now - lastNotice >= NOTIFICATION_INTERVAL_MS;
  if (shouldNotify) notifiedAt.set(key, now);
  persist();
  return { diagnostic, shouldNotify };
}

export function recentErrorDiagnostics(): readonly ErrorDiagnostic[] {
  return entries;
}
