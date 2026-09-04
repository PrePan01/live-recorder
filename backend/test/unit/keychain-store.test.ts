import { describe, expect, it } from 'vitest';
import { KeytarSecretStore } from '../../src/security/keychain-store.js';
import { KEYCHAIN_SERVICE, keychainService } from '../../src/security/keys.js';

describe('KeytarSecretStore', () => {
  it('round-trips a secret through the OS keychain and cleans up', async () => {
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