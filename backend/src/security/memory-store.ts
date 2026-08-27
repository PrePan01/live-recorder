import type { SecretStore } from './secret-store.js';

/** 内存 SecretStore：测试与 CI/无 GUI 环境使用（阶段 B）；不落盘、不依赖 keytar。 */
export class MemorySecretStore implements SecretStore {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.map.has(key);
  }
}
