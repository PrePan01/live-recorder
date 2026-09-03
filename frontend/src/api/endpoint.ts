import type { AppInstance } from '../types/desktop';
import { apiBaseUrl } from '../types/desktop';

const DEFAULT_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:43120/api/v1';

let current: AppInstance | null = null;
const listeners = new Set<(base: string) => void>();

export const EndpointResolver = {
  get base(): string {
    return current ? apiBaseUrl(current) : DEFAULT_BASE;
  },
  get instanceId(): string | null {
    return current?.instanceId ?? null;
  },
  get appInstance(): AppInstance | null {
    return current;
  },
  set(instance: AppInstance | null): void {
    current = instance;
    const base = this.base;
    for (const fn of listeners) {
      try {
        fn(base);
      } catch {
        /* 忽略订阅者异常 */
      }
    }
  },
  reset(): void {
    current = null;
  },
  subscribe(fn: (base: string) => void): () => void {
    listeners.add(fn);
    fn(this.base);
    return () => listeners.delete(fn);
  },
};