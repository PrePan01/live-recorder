import { createRequire } from 'node:module';
import type { SecretStore } from './secret-store.js';
import { keychainService } from './keys.js';

const require = createRequire(import.meta.url);
export type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

// Windows Credential Manager rejects oversized generic credential blobs. A
// complete Douyin Cookie commonly exceeds that limit, so keep each keytar
// value comfortably below it and join the chunks on read.
const CHUNK_MARKER_SUFFIX = '.lr-chunk-count';
const CHUNK_SUFFIX = '.lr-chunk-';
const MAX_CHUNK_BYTES = 400;

// 凭据能力按需加载，缺少/不可用的系统钥匙串不会阻止本地工作台启动。
let cached: Keytar | undefined;
const keytar = (): Keytar => cached ??= require('keytar') as Keytar;

/** keytar 实现：SMTP 密码等机密存操作系统 keychain（macOS Keychain / Windows Credential Manager）。
 *  服务名按环境隔离（#224 P0）：dev 用 live-recorder-dev，与生产 live-recorder 凭据互不读写。 */
export class KeytarSecretStore implements SecretStore {
  private readonly service = keychainService();

  constructor(private readonly store: Keytar = keytar()) {}

  private marker(key: string): string {
    return `${key}${CHUNK_MARKER_SUFFIX}`;
  }

  private chunkKey(key: string, index: number): string {
    return `${key}${CHUNK_SUFFIX}${index}`;
  }

  private split(value: string): string[] {
    const chunks: string[] = [];
    let current = '';
    let bytes = 0;
    for (const char of value) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (current && bytes + charBytes > MAX_CHUNK_BYTES) {
        chunks.push(current);
        current = '';
        bytes = 0;
      }
      current += char;
      bytes += charBytes;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private async chunkCount(key: string): Promise<number> {
    const raw = await this.store.getPassword(this.service, this.marker(key));
    const count = raw === null ? 0 : Number(raw);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  }

  async get(key: string): Promise<string | null> {
    const count = await this.chunkCount(key);
    if (count > 0) {
      const chunks = await Promise.all(
        Array.from({ length: count }, (_, index) => this.store.getPassword(this.service, this.chunkKey(key, index))),
      );
      return chunks.every((chunk): chunk is string => chunk !== null) ? chunks.join('') : null;
    }
    return this.store.getPassword(this.service, key);
  }
  async set(key: string, value: string): Promise<void> {
    const chunks = this.split(value);
    const previousCount = await this.chunkCount(key);
    if (chunks.length <= 1) {
      await this.store.setPassword(this.service, key, value);
      await this.store.deletePassword(this.service, this.marker(key));
      for (let index = 0; index < previousCount; index += 1) {
        await this.store.deletePassword(this.service, this.chunkKey(key, index));
      }
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      await this.store.setPassword(this.service, this.chunkKey(key, index), chunks[index]!);
    }
    // Publish the marker last so readers never use an incomplete new value.
    await this.store.setPassword(this.service, this.marker(key), String(chunks.length));
    await this.store.deletePassword(this.service, key);
    for (let index = chunks.length; index < previousCount; index += 1) {
      await this.store.deletePassword(this.service, this.chunkKey(key, index));
    }
  }
  async delete(key: string): Promise<void> {
    const count = await this.chunkCount(key);
    await this.store.deletePassword(this.service, key);
    await this.store.deletePassword(this.service, this.marker(key));
    for (let index = 0; index < count; index += 1) {
      await this.store.deletePassword(this.service, this.chunkKey(key, index));
    }
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }
}
