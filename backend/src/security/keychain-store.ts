import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
type ChunkMarker = { raw: string; count: number; version: string | undefined };

// 凭据能力按需加载，缺少/不可用的系统钥匙串不会阻止本地工作台启动。
let cached: Keytar | undefined;
const keytar = (): Keytar => cached ??= require('keytar') as Keytar;

/** keytar 实现：SMTP 密码等机密存操作系统 keychain（macOS Keychain / Windows Credential Manager）。
 *  服务名按环境隔离：dev 用 live-recorder-dev，与生产 live-recorder 凭据互不读写。 */
export class KeytarSecretStore implements SecretStore {
  private readonly service = keychainService();

  constructor(private readonly store: Keytar = keytar()) {}

  private marker(key: string): string {
    return `${key}${CHUNK_MARKER_SUFFIX}`;
  }

  private chunkKey(key: string, index: number, version?: string): string {
    return `${key}${CHUNK_SUFFIX}${version ? version + '-' : ''}${index}`;
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

  private async chunkMarker(key: string): Promise<ChunkMarker | undefined> {
    const raw = await this.store.getPassword(this.service, this.marker(key));
    if (!raw) return;
    const [length, version] = raw.split(':');
    const count = Number(length);
    if (Number.isSafeInteger(count) && count > 0) return { raw, count, version };
  }

  private async deleteChunks(key: string, marker?: ChunkMarker): Promise<void> {
    if (!marker) return;
    for (let index = 0; index < marker.count; index += 1) {
      await this.store.deletePassword(this.service, this.chunkKey(key, index, marker.version));
    }
  }

  async get(key: string): Promise<string | null> {
    let marker = await this.chunkMarker(key);
    while (marker) {
      const { count, version, raw } = marker;
      const chunks = await Promise.all(
        Array.from({ length: count }, (_, index) => this.store.getPassword(this.service, this.chunkKey(key, index, version))),
      );
      if (chunks.every(chunk => chunk !== null)) return chunks.join('');
      marker = await this.chunkMarker(key);
      if (marker?.raw === raw) return null;
    }
    return this.store.getPassword(this.service, key);
  }
  async set(key: string, value: string): Promise<void> {
    const chunks = this.split(value);
    const previous = await this.chunkMarker(key);
    if (chunks.length <= 1) {
      await this.store.setPassword(this.service, key, value);
      await this.store.deletePassword(this.service, this.marker(key));
    } else {
      const version = randomUUID();
      const marker = { raw: `${chunks.length}:${version}`, count: chunks.length, version };
      try {
        for (const [index, chunk] of chunks.entries()) {
          await this.store.setPassword(this.service, this.chunkKey(key, index, version), chunk);
        }
        // Publish only after every chunk is present. Readers of the previous
        // marker can still read the old value until the switch is committed.
        await this.store.setPassword(this.service, this.marker(key), marker.raw);
      } catch (error) {
        await this.deleteChunks(key, marker).catch(() => undefined);
        throw error;
      }
      await this.store.deletePassword(this.service, key).catch(() => undefined);
    }
    await this.deleteChunks(key, previous).catch(() => undefined);
  }
  async delete(key: string): Promise<void> {
    const marker = await this.chunkMarker(key);
    await this.store.deletePassword(this.service, key);
    await this.store.deletePassword(this.service, this.marker(key));
    await this.deleteChunks(key, marker).catch(() => undefined);
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }
}
