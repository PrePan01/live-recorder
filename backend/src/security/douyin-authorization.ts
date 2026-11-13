import { DOUYIN_COOKIE_KEY } from "./keys.js";
import type { SecretStore } from "./secret-store.js";

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
