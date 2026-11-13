import { describe, expect, it } from 'vitest';
import { KeytarSecretStore, type Keytar } from '../../src/security/keychain-store.js';
import { KEYCHAIN_SERVICE, keychainService } from '../../src/security/keys.js';

describe('KeytarSecretStore', () => {
  it('preserves a legacy chunked credential if a replacement is interrupted', async () => {
    const credentials = new Map([
      ['douyin.cookie.lr-chunk-count', '2'],
      ['douyin.cookie.lr-chunk-0', 'sessionid=old'],
      ['douyin.cookie.lr-chunk-1', '; ttwid=visitor'],
    ]);
    let fail = true;
    const store = new KeytarSecretStore({
      async getPassword(_service, account) { return credentials.get(account) ?? null; },
      async setPassword(_service, account, password) {
        if (fail && account.endsWith('-1')) throw new Error('write interrupted');
        credentials.set(account, password);
      },
      async deletePassword(_service, account) { return credentials.delete(account); },
    });
    const replacement = 'sessionid=' + 'x'.repeat(850);
    await expect(store.set('douyin.cookie', replacement)).rejects.toThrow('write interrupted');
    expect(await store.get('douyin.cookie')).toBe('sessionid=old; ttwid=visitor');
    expect(credentials.size).toBe(3);
    fail = false;
    await store.set('douyin.cookie', replacement);
    expect(await store.get('douyin.cookie')).toBe(replacement);
    expect(credentials.has('douyin.cookie.lr-chunk-0')).toBe(false);
  });

  it('splits oversized values and supports overwrite and cleanup', async () => {
    const credentials = new Map<string, string>();
    const fake: Keytar = {
      async getPassword(_service, account) { return credentials.get(account) ?? null; },
      async setPassword(_service, account, password) { credentials.set(account, password); },
      async deletePassword(_service, account) { return credentials.delete(account); },
    };
    const store = new KeytarSecretStore(fake);
    const value = 'sessionid=' + 'x'.repeat(1800);

    await store.set('douyin.cookie', value);
    expect(await store.get('douyin.cookie')).toBe(value);
    expect(credentials.has('douyin.cookie')).toBe(false);

    await store.set('douyin.cookie', 'short=value');
    expect(await store.get('douyin.cookie')).toBe('short=value');
    expect(credentials.has('douyin.cookie')).toBe(true);

    await store.delete('douyin.cookie');
    expect(await store.has('douyin.cookie')).toBe(false);
    expect(credentials.size).toBe(0);
  });

  // The desktop product supports macOS Keychain and Windows Credential Manager.
  // Ubuntu's hosted runners neither ship libsecret nor expose a login keyring.
  // The injected-store test above still verifies the storage implementation there.
  it.skipIf(process.platform === 'linux')('round-trips a secret through the OS keychain and cleans up', async () => {
    const store = new KeytarSecretStore();
    const key = `test.${Date.now()}`;
    try {
      expect(await store.has(key)).toBe(false);
      await store.set(key, 'value-1');
      expect(await store.has(key)).toBe(true);
      expect(await store.get(key)).toBe('value-1');
      await store.set(key, 'value-2');
      expect(await store.get(key)).toBe('value-2');
    } finally {
      await store.delete(key);
      expect(await store.has(key)).toBe(false);
    }
  });
});

describe('#224 钥匙串服务名按环境隔离', () => {
  it('生产默认 live-recorder；dev（LIVE_RECORDER_DATA_DIR）用 live-recorder-dev', () => {
    const prev = process.env.LIVE_RECORDER_DATA_DIR;
    try {
      delete process.env.LIVE_RECORDER_DATA_DIR;
      expect(keychainService()).toBe(KEYCHAIN_SERVICE);
      process.env.LIVE_RECORDER_DATA_DIR = '/repo/.dev-data';
      expect(keychainService()).toBe('live-recorder-dev');
    } finally {
      if (prev === undefined) delete process.env.LIVE_RECORDER_DATA_DIR;
      else process.env.LIVE_RECORDER_DATA_DIR = prev;
    }
  });
});
