import { DOUYIN_COOKIE_KEY } from "./keys.js";
import type { SecretStore } from "./secret-store.js";

export type DouyinCookieStatus = 'valid' | 'invalid' | 'unknown';

/** The account endpoint confirms login independently of live-room access. */
export async function checkDouyinCookieStatus(
  cookie: string,
  fetcher: typeof fetch = fetch,
): Promise<DouyinCookieStatus> {
  try {
    const response = await fetcher('https://creator.douyin.com/web/api/media/user/info', {
      headers: {
        Cookie: cookie,
        Referer: 'https://creator.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return 'unknown';
    const body = await response.json() as { status_code?: unknown };
    if (body.status_code === 0) return 'valid';
    if (body.status_code === 8) return 'invalid';
  } catch { /* the site did not provide evidence about this session */ }
  return 'unknown';
}

export class DouyinAuthorizationStore {
  private generation = 0;
  private pendingWrite = Promise.resolve();

  constructor(private readonly store: SecretStore) {}

  get revision(): number {
    return this.generation;
  }

  async cookie(): Promise<string | undefined> {
    const raw = await this.store.get(DOUYIN_COOKIE_KEY);
    if (!raw) return;
    if (!raw.startsWith("{")) return raw;
    try {
      const stored = JSON.parse(raw) as { cookie?: unknown } | null;
      if (typeof stored?.cookie === "string") return stored.cookie;
    } catch {
      return;
    }
  }

  save(cookie?: string): Promise<void> {
    const write = this.pendingWrite.then(async () => {
      if (cookie) await this.store.set(DOUYIN_COOKIE_KEY, cookie);
      else await this.store.delete(DOUYIN_COOKIE_KEY);
      this.generation += 1;
    });
    this.pendingWrite = write.catch(() => undefined);
    return write;
  }
}
