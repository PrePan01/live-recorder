import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

// A single UI clock replaces one interval per room card. It is paused whenever
// the document is hidden, so background recording work never keeps WebView
// rendering timers alive.
let value = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  value = Date.now();
  for (const listener of listeners) listener();
}

function updateTimer(): void {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  if (listeners.size > 0 && visible && !timer) timer = setInterval(emit, 1_000);
  if ((!visible || listeners.size === 0) && timer) {
    clearInterval(timer);
    timer = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    updateTimer();
    if (document.visibilityState === 'visible') emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  updateTimer();
  return () => {
    listeners.delete(listener);
    updateTimer();
  };
}

const noopSubscribe = () => () => undefined;

/** Timestamp updates once per second only while this element is visible. */
export function useDisplayClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : noopSubscribe, () => value, () => value);
}

/** IntersectionObserver gates text-only time updates to cards on screen. */
export function useElementVisible<T extends Element>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [visible, setVisible] = useState(true);
  const ref = useCallback((next: T | null) => setNode(next), []);
  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [ref, visible];
}
