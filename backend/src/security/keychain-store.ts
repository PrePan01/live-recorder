import { createRequire } from 'node:module';
import type { SecretStore } from './secret-store.js';
import { keychainService } from './keys.js';

const require = createRequire(import.meta.url);
type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

// 凭据能力按需加载，缺少/不可用的系统钥匙串不会阻止本地工作台启动。
let cached: Keytar | undefined;
const keytar = (): Keytar => cached ??= require('keytar') as Keytar;

/** keytar 实现：SMTP 密码等机密存操作系统 keychain（macOS Keychain / Windows Credential Manager）。
 *  服务名按环境隔离（#224 P0）：dev 用 live-recorder-dev，与生产 live-recorder 凭据互不读写。 */
export class KeytarSecretStore implements SecretStore {
  private readonly service = keychainService();

  async get(key: string): Promise<string | null> {
    return keytar().getPassword(this.service, key);
  }
  async set(key: string, value: string): Promise<void> {
    await keytar().setPassword(this.service, key, value);
  }
  async delete(key: string): Promise<void> {
    await keytar().deletePassword(this.service, key);
  }
  async has(key: string): Promise<boolean> {
    return (await keytar().getPassword(this.service, key)) !== null;
  }
}