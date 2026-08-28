import { createRequire } from 'node:module';
import type { SecretStore } from './secret-store.js';
import { KEYCHAIN_SERVICE } from './keys.js';

const require = createRequire(import.meta.url);
const keytar = require('keytar') as {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

/** keytar 实现：SMTP 密码等机密存操作系统 keychain（macOS Keychain / Windows Credential Manager）。 */
export class KeytarSecretStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    return keytar.getPassword(KEYCHAIN_SERVICE, key);
  }
  async set(key: string, value: string): Promise<void> {
    await keytar.setPassword(KEYCHAIN_SERVICE, key, value);
  }
  async delete(key: string): Promise<void> {
    await keytar.deletePassword(KEYCHAIN_SERVICE, key);
  }
  async has(key: string): Promise<boolean> {
    return (await keytar.getPassword(KEYCHAIN_SERVICE, key)) !== null;
  }
}